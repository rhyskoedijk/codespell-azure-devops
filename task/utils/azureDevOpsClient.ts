import * as azdev from 'azure-devops-node-api';
import { IGitApi } from 'azure-devops-node-api/GitApi';
import {
  CommentThreadStatus,
  CommentType,
  GitPullRequestCommentThread,
  ItemContentType,
  VersionControlChangeType,
} from 'azure-devops-node-api/interfaces/GitInterfaces';
import { debug, error, getEndpointAuthorizationParameter, getInput } from 'azure-pipelines-task-lib/task';
import fs from 'fs';
import { CodespellCommandProcessor } from './codespellCommandProcessor';
import { IFile, IFileSuggestion } from './types';

export interface IPullRequstLock {
  wasAcquired: boolean;
  ownerJobId?: string;
}

export class AzureDevOpsClient {
  private organizationUri: string;
  private project: string;
  private repositoryId: string;
  private userId: string | null = null;
  private connection: azdev.WebApi;
  private commandProcessor: CodespellCommandProcessor;

  readonly lockJobIdPropertyName = 'Codespell.Lock.JobId';

  constructor(organizationUri: string, project: string, repositoryId: string) {
    this.organizationUri = organizationUri;
    this.project = project;
    this.repositoryId = repositoryId;
    this.connection = new azdev.WebApi(organizationUri, azdev.getPersonalAccessTokenHandler(this.getAccessToken()));
    this.commandProcessor = new CodespellCommandProcessor();
  }

  public async acquireLockForPullRequest(pullRequestId: number, jobId: string): Promise<IPullRequstLock> {
    try {
      // Check if the lock is already acquired by another job
      const git = await this.connection.getGitApi();
      const existingProperties = await git.getPullRequestProperties(this.repositoryId, pullRequestId, this.project);
      const existingJobId = existingProperties?.['value']?.['Codespell.Lock.JobId']?.['$value'];
      if (existingJobId) {
        return {
          wasAcquired: jobId === existingJobId,
          ownerJobId: existingJobId,
        };
      }

      // Acquire the lock
      console.info(`Acquiring lock for PR #${pullRequestId}`);
      const patch = [
        {
          op: 'add',
          path: '/' + this.lockJobIdPropertyName,
          value: jobId,
        },
      ];
      const newProperties = await git.updatePullRequestProperties(
        null,
        patch,
        this.repositoryId,
        pullRequestId,
        this.project,
      );
      return {
        wasAcquired: true,
        ownerJobId: newProperties?.['value']?.['Codespell.Lock.JobId']?.['$value'] || '',
      };
    } catch (e) {
      console.debug(e); // Dump the error stack trace to help with debugging
      error(`Failed to check and acquire lock for pull request: ${e}`);
      return {
        wasAcquired: false,
      };
    }
  }

  public async releaseLockForPullRequest(pullRequestId: number): Promise<void> {
    try {
      // Release the lock
      console.info(`Releasing lock for PR #${pullRequestId}`);
      const git = await this.connection.getGitApi();
      const patch = [
        {
          op: 'remove',
          path: '/' + this.lockJobIdPropertyName,
        },
      ];
      await git.updatePullRequestProperties(null, patch, this.repositoryId, pullRequestId, this.project);
    } catch (e) {
      console.debug(e); // Dump the error stack trace to help with debugging
      error(`Failed to release lock for pull request: ${e}`);
    }
  }

  public async commitSuggestionsToPullRequest(options: {
    pullRequestId: number;
    files: IFile[];
    suggestions: IFileSuggestion[];
  }) {
    try {
      // Get pull request details
      const git = await this.connection.getGitApi();
      const pullRequest = await git.getPullRequest(this.repositoryId, options.pullRequestId, this.project);
      if (!pullRequest) {
        throw new Error(`Could not find pull request with ID ${options.pullRequestId}`);
      }

      // Find all active threads in the PR
      const userId = await this.getUserId();
      const activeThreads = (await git.getThreads(this.repositoryId, options.pullRequestId, this.project)).filter(
        (thread) => !thread.isDeleted && thread.status === CommentThreadStatus.Active,
      );

      // Commit all files which have been automatically fixed or have suggestions that aren't already in an active thread
      const filesToCommit = options.files || [];
      const sugestionsToCommit = (options.suggestions || []).filter(
        (suggestion) => !activeThreads.some((thread) => this.isThreadForSuggestion(userId, thread, suggestion)),
      );
      const filePathsToCommit = [...new Set(filesToCommit.concat(sugestionsToCommit).map((f) => f.path))];
      if (filePathsToCommit.length === 0) {
        return;
      }

      // For every suggestion with multiple options, update the the file with a placeholder text containing all options.
      // This is required so that when we commit the file change, the file generates a diff in the PR and can then be commented on with suggestions.
      // If the file is not modified, the PR will not show the diff and we cannot comment on it with the suggestion later.
      sugestionsToCommit
        ?.filter((suggestion) => suggestion.suggestions.length > 1)
        ?.forEach((suggestion) => {
          try {
            const lines = fs.readFileSync(suggestion.path).toString().split('\n');
            const line = lines[suggestion.lineNumber - 1];
            const lineStart = line.substring(0, line.indexOf(suggestion.word));
            const lineEnd = line.substring(line.indexOf(suggestion.word) + suggestion.word.length);
            const newWordText = getWordPlaceholderTextForSuggestion(suggestion);
            const newLineText = lineStart + newWordText + lineEnd;
            if (line.indexOf(newWordText) === -1) {
              lines[suggestion.lineNumber - 1] = newLineText;
              suggestion.lineText = '>' + newLineText; // HACK: Workaround to fix the line context for the suggestion
              fs.writeFileSync(suggestion.path, Buffer.from(lines.join('\n')));
            }
          } catch (e) {
            console.debug(e); // Dump the error stack trace to help with debugging
            throw new Error(`Failed to patch local file with multiple suggestions: ${e}`);
          }
        });

      // Commit local changes to the pull request source branch
      console.info('Committing suggestions for files:', filePathsToCommit);
      const changedFilePaths = await this.getChangedFilePathsForPullRequest(git, options.pullRequestId);
      console.log(changedFilePaths);

      await git.createPush(
        {
          refUpdates: [
            {
              name: pullRequest.sourceRefName,
              oldObjectId: pullRequest.lastMergeSourceCommit?.commitId,
            },
          ],
          commits: [
            {
              comment: 'Codespell corrections',
              changes: filePathsToCommit.map((path) => ({
                changeType: VersionControlChangeType.Edit,
                item: {
                  path: normalizeDevOpsPath(path),
                },
                newContent: {
                  content: fs.readFileSync(path).toString('base64'),
                  contentType: ItemContentType.Base64Encoded,
                },
              })),
            },
          ],
        },
        this.repositoryId,
        this.project,
      );
    } catch (e) {
      console.debug(e); // Dump the error stack trace to help with debugging
      throw new Error(`Failed to commit codespell suggestions to pull request: ${e}`);
    }
  }

  public async commentSuggestionsOnPullRequest(options: { pullRequestId: number; suggestions: IFileSuggestion[] }) {
    try {
      if (options.suggestions.length > 0) {
        console.info(`Creating suggestion comment threads for ${options.suggestions.length} suggestion(s)...`);
      }

      // Find all added or edited files paths in the PR
      const git = await this.connection.getGitApi();
      const changedFilePaths = await this.getChangedFilePathsForPullRequest(git, options.pullRequestId);

      // Find all active threads in the PR
      const activeThreads = (await git.getThreads(this.repositoryId, options.pullRequestId, this.project)).filter(
        (thread) => !thread.isDeleted && thread.status === CommentThreadStatus.Active,
      );

      // Filter suggestions to only those that are relevant to the PR file changes and that have not been suggested yet
      const userId = await this.getUserId();
      const suggestionsToComment = options.suggestions.filter((suggestion) => {
        const skipMessage = `Suggestion for [${suggestion.path}:${suggestion.lineNumber} ${suggestion.word}] is being skipped because`;
        if (!changedFilePaths.includes(normalizeDevOpsPath(suggestion.path))) {
          console.info(skipMessage, 'it is not in the changed files list for the pull request.');
          return false;
        } else if (activeThreads.some((thread) => this.isThreadForSuggestion(userId, thread, suggestion))) {
          console.info(skipMessage, 'it already has an active suggestion thread in the pull request.');
          return false;
        } else {
          return true;
        }
      });

      // Resolve threads for suggestions that have been fixed
      activeThreads.forEach(async (thread) => {
        const threadSuggestion = this.getSuggestionFromThread(thread);
        if (!threadSuggestion) {
          return; // Skip threads without a suggestion property, they're not ours
        }

        const activeSuggestion = options.suggestions.find((suggestion) =>
          this.isThreadForSuggestion(userId, thread, suggestion),
        );
        if (!activeSuggestion && thread.id) {
          console.info(`Closing suggestion thread ${thread.id} as fixed for:`, threadSuggestion);
          await git.updateThread(
            {
              status: CommentThreadStatus.Fixed,
            },
            this.repositoryId,
            options.pullRequestId,
            thread.id,
            this.project,
          );
        }
      });

      suggestionsToComment.forEach(async (suggestion) => {
        console.info('Creating suggestion thread for:', suggestion);
        const wordPlaceholderText = getWordPlaceholderTextForSuggestion(suggestion);
        const suggestionLineContextText =
          suggestion.lineText.indexOf(wordPlaceholderText) !== -1 ? wordPlaceholderText : suggestion.word;
        const suggestionLineContextStartOffset = suggestion.lineText.indexOf(suggestionLineContextText);
        const suggestionLineContextEndOffset = suggestionLineContextStartOffset + suggestionLineContextText.length;
        await git.createThread(
          {
            comments: [
              {
                commentType: CommentType.CodeChange,
                content:
                  `Found misspelt word \`${suggestion.word}\`.\n\n` +
                  suggestion.suggestions.map((s) => '```suggestion\n' + s + '\n```').join('\n') +
                  '\n' +
                  this.commandProcessor.getCommandHelpTextFor(suggestion),
              },
            ],
            status: CommentThreadStatus.Active,
            threadContext: {
              filePath: normalizeDevOpsPath(suggestion.path),
              rightFileStart: {
                line: suggestion.lineNumber,
                offset: suggestionLineContextStartOffset,
              },
              rightFileEnd: {
                line: suggestion.lineNumber,
                offset: suggestionLineContextEndOffset,
              },
            },
            properties: {
              'codespell:suggestion': {
                $type: 'System.String',
                $value: JSON.stringify(suggestion),
              },
            },
          },
          this.repositoryId,
          options.pullRequestId,
          this.project,
        );
      });
    } catch (e) {
      console.debug(e); // Dump the error stack trace to help with debugging
      throw new Error(`Failed to comment codespell suggestions on pull request: ${e}`);
    }
  }

  public async processCommandsInCommentsForPullRequest(options: { pullRequestId: number }) {
    try {
      const git = await this.connection.getGitApi();
      const userId = await this.getUserId();

      // Process all [active] threads in the pull request
      await git.getThreads(this.repositoryId, options.pullRequestId, this.project).then(async (threads) => {
        const activeThreads = threads.filter((t) => !t.isDeleted && t.status == CommentThreadStatus.Active);
        activeThreads.forEach((thread) => {
          // If the thread is not for a suggestion, ignore it
          const suggestion = this.getSuggestionFromThread(thread);
          if (!suggestion) {
            return;
          }

          // Process all comments in the thread
          thread.comments?.forEach(async (comment) => {
            // If the comment was already reacted to by our user, skip it
            if (comment.usersLiked?.some((user) => user.id === userId)) {
              return;
            }

            // Process all commands in the comment, if any
            let commandsWereProcessed = await this.commandProcessor.processCommands({
              pullRequestId: options.pullRequestId,
              thread: thread,
              comment: comment,
              suggestion: suggestion,
            });

            // If any commands were processed, react to the comment so that we don't process it again
            if (commandsWereProcessed && thread.id && comment.id) {
              await git.createLike(this.repositoryId, options.pullRequestId, thread.id, comment.id, this.project);
            }
          });
        });
      });
    } catch (e) {
      console.debug(e); // Dump the error stack trace to help with debugging
      throw new Error(`Failed to process user commands in pull request: ${e}`);
    }
  }

  private async getChangedFilePathsForPullRequest(git: IGitApi, pullRequestId: number): Promise<string[]> {
    const iterations = await git.getPullRequestIterations(this.repositoryId, pullRequestId, this.project);
    const files: string[] = [];
    for (const iteration of iterations) {
      const changes = await git.getPullRequestIterationChanges(
        this.repositoryId,
        pullRequestId,
        iteration.id || 0,
        this.project,
        2000,
      );
      const iterationFiles = changes?.changeEntries
        ?.filter((c) => c.changeType === VersionControlChangeType.Add || c.changeType === VersionControlChangeType.Edit)
        ?.filter((c) => c.item?.isFolder !== true)
        ?.flatMap((c) => c.item?.path || '');
      if (iterationFiles) {
        files.push(...iterationFiles);
      }
    }
    return [...new Set(files.map((f) => normalizeDevOpsPath(f)))];
  }

  private getSuggestionFromThread(thread: GitPullRequestCommentThread): IFileSuggestion | null {
    const suggestion = thread.properties?.['codespell:suggestion']?.['$value'];
    if (!suggestion) {
      return null;
    }
    return JSON.parse(suggestion);
  }

  private isThreadForSuggestion(
    userId: string | null,
    thread: GitPullRequestCommentThread,
    suggestion: IFileSuggestion,
  ): boolean {
    const threadSuggestion = this.getSuggestionFromThread(thread);
    return (
      (thread.isDeleted === false && // is not deleted
        thread.status === CommentThreadStatus.Active && // is active
        thread.comments?.some((comment) => comment.author?.id === userId) && // has a comment from our user id
        threadSuggestion && // has a codespell suggestion property
        threadSuggestion.path === suggestion.path && // is for the same file
        threadSuggestion.lineNumber === suggestion.lineNumber && // is for the same line
        threadSuggestion.word === suggestion.word) || // is for the same word
      false
    );
  }

  private async getUserId(): Promise<string> {
    return (this.userId ||= (await this.connection.connect()).authenticatedUser?.id || '');
  }

  private getAccessToken(): string {
    const accessToken = getInput('accessToken');
    if (accessToken) {
      debug('Using user-supplied access token for authentication');
      return accessToken;
    }

    const serviceConnectionName = getInput('serviceConnection');
    if (serviceConnectionName) {
      var serviceConnectionToken = getEndpointAuthorizationParameter(serviceConnectionName, 'apitoken', false);
      if (serviceConnectionToken) {
        debug('Using user-supplied service connection for authentication');
        return serviceConnectionToken;
      }
    }

    const systemAccessToken = getEndpointAuthorizationParameter('SystemVssConnection', 'AccessToken', false);
    if (systemAccessToken) {
      debug("Using SystemVssConnection's access token for authentication");
      return systemAccessToken;
    }

    throw new Error('Failed to get Azure DevOps access token');
  }
}

function normalizeDevOpsPath(path: string): string {
  // Convert backslashes to forward slashes, convert './' => '/' and ensure the path starts with a forward slash if it doesn't already, this is how DevOps paths are formatted
  return path
    .replace(/\\/g, '/')
    .replace(/^\.\//, '/')
    .replace(/^([^/])/, '/$1');
}

function getWordPlaceholderTextForSuggestion(suggestion: IFileSuggestion): string {
  return `${suggestion.word} --> ${suggestion.suggestions.join('|')}`;
}
