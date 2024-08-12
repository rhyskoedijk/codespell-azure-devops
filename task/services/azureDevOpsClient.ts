import * as azdev from "azure-devops-node-api";
import { debug, warning, error, getEndpointAuthorizationParameter, getInput } from "azure-pipelines-task-lib/task"
import { GitPullRequestCommentThread, Comment, CommentThreadStatus, CommentType, VersionControlChangeType, ItemContentType } from "azure-devops-node-api/interfaces/GitInterfaces";
import fs from "fs";

export interface IFile {
  path: string;
}
export interface IFileSuggestion extends IFile {
  lineNumber: number;
  lineText: string;
  word: string;
  suggestions: string[];
}

export class AzureDevOpsClient {
  private organizationUri: string;
  private project: string;
  private repositoryId: string;
  private userId: string | null = null;
  private connection: azdev.WebApi;

  readonly commandPrefix = "@codespell";

  constructor(organizationUri: string, project: string, repositoryId: string) {
    this.organizationUri = organizationUri;
    this.project = project;
    this.repositoryId = repositoryId;
    this.connection = new azdev.WebApi(
      organizationUri,
      azdev.getPersonalAccessTokenHandler(getAzureDevOpsAccessToken())
    );
  }

  public async commitSuggestionsToPullRequest(options: {
    pullRequestId: number,
    fixedFiles: IFile[],
    suggestions: IFileSuggestion[]
  }) {
    let git = await this.connection.getGitApi();
    try {

      // Commit all files which have been automatically fixed or have multiple suggestion options to pick from
      let suggestionsWithMultipleOptions = options.suggestions?.filter(suggestion => suggestion.suggestions.length > 1);
      let filePathsToCommit = [...new Set((options.fixedFiles || []).concat(suggestionsWithMultipleOptions || []).map(f => f.path))];
      if (filePathsToCommit.length === 0) {
        return;
      }

      // For every suggestion with multiple options, update the line in the file to include a placeholder text with all suggestions
      // This is required so that when we commit the changes, the file is actually changed in the PR and can then be commented on with suggestions
      suggestionsWithMultipleOptions?.forEach(suggestion => {
        try {
          let contents = fs.readFileSync(suggestion.path);
          let lines = contents.toString().split("\n");
          let line = lines[suggestion.lineNumber - 1];
          let lineStart = line.substring(0, line.indexOf(suggestion.word));
          let lineEnd = line.substring(line.indexOf(suggestion.word) + suggestion.word.length);
          let newWord = `${suggestion.word}=[${suggestion.suggestions.join("|")}]`;
          let newLine = lineStart + newWord + lineEnd;
          lines[suggestion.lineNumber - 1] = newLine;
          suggestion.word = newWord;
          suggestion.lineText = newLine;
          fs.writeFileSync(suggestion.path, Buffer.from(lines.join("\n")));
        }
        catch(e) {
          error(`Failed to patch local file with multiple suggestions: ${e}`);
        }
      });

      // Get pull request details
      let pullRequest = await git.getPullRequest(this.repositoryId, options.pullRequestId, this.project);
      if (!pullRequest) {
        throw new Error(`Could not find pull request with ID ${options.pullRequestId}`);
      }

      // Commit local changes to the pull request source branch
      console.info("Committing suggestions to pull request for files", filePathsToCommit);
      await git.createPush({
        refUpdates: [{
          name: pullRequest.sourceRefName,
          oldObjectId: pullRequest.lastMergeSourceCommit?.commitId
        }],
        commits: [{
          comment: "Codespell corrections",
          changes: filePathsToCommit.map(path => ({
            changeType: VersionControlChangeType.Edit,
            item: {
              path: path.replace(/^\.+/g, "")
            },
            newContent: {
              content: fs.readFileSync(path).toString("base64"),
              contentType: ItemContentType.Base64Encoded
            }
          }))
        }]
      }, this.repositoryId, this.project);

    }
    catch (e) {
      error(`Failed to commit codespell suggestions to pull request: ${e}`);
    }
  }

  public async commentSuggestionsOnPullRequest(options: {
    pullRequestId: number,
    suggestions: IFileSuggestion[]
  }) {
    let userId = await this.getUserId();
    let git = await this.connection.getGitApi();

    try {

      // Find all added or edited files paths in the PR
      let changedFilePaths = await this.getChangedFilePathsForPullRequest(options.pullRequestId);

      // Find all active threads in the PR
      let activeThreads = (await git.getThreads(this.repositoryId, options.pullRequestId, this.project))
        .filter(thread => !thread.isDeleted && thread.status === CommentThreadStatus.Active);

      // Filter suggestions to only those that are relevant to the PR file changes and that have not been suggested yet
      let suggestionsToComment = options.suggestions.filter(suggestion => {
        let isFileAddedOrEdited = changedFilePaths?.some(filePath => filePath === suggestion.path.replace(/^\.+/g, ""));
        let hasActiveSuggestionThread = activeThreads.some(thread => isThreadForSuggestion(userId, thread, suggestion));
        return isFileAddedOrEdited && !hasActiveSuggestionThread;
      });

      // Resolve threads for suggestions that have been fixed
      activeThreads.forEach(thread => {
        let suggestion = options.suggestions.find(suggestion => isThreadForSuggestion(userId, thread, suggestion));
        if (!suggestion && thread.id) {
          console.info(`Closing suggestion thread as fixed [pr: ${options.pullRequestId}, thread: ${thread.id}]`);
          git.updateThread({
            status: CommentThreadStatus.Fixed
          }, this.repositoryId, options.pullRequestId, thread.id, this.project);
        }
      });

      suggestionsToComment.forEach(async (suggestion) => {
        console.info("Creating suggestion thread for:", suggestion);
        let suggestionLineStartOffset = suggestion.lineText.indexOf(suggestion.word) + 1;
        let suggestionLineEndOffset = suggestionLineStartOffset + suggestion.word.length;
        await git.createThread({
          comments: [{
            commentType: CommentType.CodeChange,
            content: (
              suggestion.suggestions.map(s => "```suggestion\n" + s + "\n```").join("\n") + "\n" +
              commandHelpText(this.commandPrefix, suggestion)
            )
          }],
          status: CommentThreadStatus.Active,
          threadContext: {
            filePath: suggestion.path.replace(/^\.+/g, ""),
            rightFileStart: {
              line: suggestion.lineNumber,
              offset: suggestionLineStartOffset
            },
            rightFileEnd: {
              line: suggestion.lineNumber,
              offset: suggestionLineEndOffset
            }
          },
          properties: {
            "codespell:suggestion": {
              "$type": "System.String",
              "$value": JSON.stringify(suggestion)
            }
          }
        }, this.repositoryId, options.pullRequestId, this.project);
      });

    }
    catch (e) {
      error(`Failed to comment codespell suggestions on pull request: ${e}`);
    }
  }

  public async processUserCommandsInPullRequest(options: {
    pullRequestId: number
  }) {
    let git = await this.connection.getGitApi();
    try {

      await git.getThreads(this.repositoryId, options.pullRequestId, this.project).then(async (threads) => {
        let activeThreads = threads.filter(t => !t.isDeleted && t.status == CommentThreadStatus.Active);
        activeThreads.forEach(thread => {
          thread.comments?.forEach(async (comment) => {
            await this.processUserCommandInComment({
              pullRequestId: options.pullRequestId,
              thread: thread,
              comment: comment
            });
          });

        });
      });

    }
    catch (e) {
      error(`Failed to process user commands in pull request: ${e}`);
    }
  }

  private async processUserCommandInComment(options: {
    pullRequestId: number,
    thread: GitPullRequestCommentThread,
    comment: Comment
  }) {
    // If the comment doesn't have a command prefix, ignore it
    if (!options.comment.content?.startsWith(this.commandPrefix)) {
      return;
    }

    // If the comment was already reacted to by our user, ignore it
    let userId = await this.getUserId();
    if (options.comment.usersLiked?.some(user => user.id === userId)) {
      return;
    }

    // Parse the command
    let command: string[] = options.comment.content.substr(this.commandPrefix.length).trim().split(" ").map(c => c.trim().toLocaleLowerCase());
    if (command.length === 0) {
      return;
    }

    // Parse the suggestion info from the thread properties
    let suggestion = getThreadSuggestionProperty(options.thread);
    if (!suggestion) {
      return;
    }

    console.info(`Processing command '${command.join(" ")}' in [pr: ${options.pullRequestId}, thread: ${options.thread.id}, comment: ${options.comment.id}] for suggestion:`, suggestion);
    switch (command[0]) {
      case "ignore":
        let ignoreTarget = command.length > 1 ? command[1] : "this";
        await this.processIgnoreCommand(ignoreTarget, options);
        break;
      default:
        warning(`Unknown command '${command[0]}'`);
        break;
    }

    // React to the comment so that we don't process it again
    if (options.thread.id && options.comment.id) {
      let git = await this.connection.getGitApi();
      await git.createLike(this.repositoryId, options.pullRequestId, options.thread.id, options.comment.id, this.project);
    }
  }

  private async processIgnoreCommand(ignoreTarget: string, options: {
    pullRequestId: number,
    thread: GitPullRequestCommentThread,
    comment: Comment
  }) {
    let git = await this.connection.getGitApi();
    // TODO: Implement this...
    //       @codespell ignore              = # codespell:ignore x
    //       @codespell ignore this         = # codespell:ignore x
    //       @codespell ignore word         = [codespell:ignore-words=x] 
    //       @codespell ignore line         = # codespell:ignore
    //       @codespell ignore file         = [codespell:skip=file]
    //       @codespell ignore ext[ension]  = [codespell:skip=*.ext]
    //       @codespell ignore dir[ectory]  = [codespell:skip=dir]
    //throw new Error("Command not implemented");
  }

  private async getUserId(): Promise<string | null> {
    return (this.userId ||= (await this.connection.connect()).authenticatedUser?.id || null);
  }

  private async getChangedFilePathsForPullRequest(pullRequestId: number): Promise<string[]> {
    let git = await this.connection.getGitApi();
    const iterations = await git.getPullRequestIterations(this.repositoryId, pullRequestId, this.project);
    const files: string[] = [];
    for (const iteration of iterations) {
      const changes = await git.getPullRequestIterationChanges(this.repositoryId, pullRequestId, iteration.id || 0, this.project, 2000);
      const iterationFiles = changes?.changeEntries
        ?.filter(c => c.changeType === VersionControlChangeType.Add || c.changeType === VersionControlChangeType.Edit)
        ?.filter(c => c.item?.isFolder !== true)
        ?.flatMap(c => c.item?.path || '');
      if (iterationFiles) {
        files.push(...iterationFiles);
      }
    }

    return files;
  }
}

function getAzureDevOpsAccessToken(): string {
  let accessToken = getInput("accessToken");
  if (accessToken) {
    debug("Using user-supplied access token for authentication");
    return accessToken;
  }

  let serviceConnectionName = getInput("serviceConnection");
  if (serviceConnectionName) {
    var serviceConnectionToken = getEndpointAuthorizationParameter(serviceConnectionName, "apitoken", false);
    if (serviceConnectionToken) {
      debug("Using user-supplied service connection for authentication");
      return serviceConnectionToken;
    }
  }

  let systemAccessToken = getEndpointAuthorizationParameter("SystemVssConnection", "AccessToken", false);
  if (systemAccessToken) {
    debug("Using SystemVssConnection's access token for authentication");
    return systemAccessToken;
  }

  throw new Error("Failed to get Azure DevOps access token");
}

function getThreadSuggestionProperty(thread: GitPullRequestCommentThread): IFileSuggestion | null {
  let suggestion = thread.properties?.["codespell:suggestion"]?.["$value"];
  if (!suggestion) {
    return null;
  }
  return JSON.parse(suggestion);
}

function isThreadForSuggestion(userId: string | null, thread: GitPullRequestCommentThread, suggestion: IFileSuggestion): boolean {
  let threadSuggestion = getThreadSuggestionProperty(thread);
  return (
    thread.isDeleted === false && // is not deleted
    thread.status === CommentThreadStatus.Active && // is active
    thread.comments?.some(comment => comment.author?.id === userId) && // has a comment from our user id
    threadSuggestion && // has a codespell suggestion property
    threadSuggestion.path === suggestion.path && // is for the same file
    threadSuggestion.lineNumber === suggestion.lineNumber && // is for the same line
    threadSuggestion.word === suggestion.word // is for the same word
  ) || false;
}

function commandHelpText(commandPrefix: string, suggestion: IFileSuggestion): string {
  return [
    "<details>",
    "<summary>🛠️ Codespell commands and options</summary>",
    "",
    "You can trigger Codespell actions by replying to this comment with any of the following commands:",
    " - `" + commandPrefix + " ignore this` will ignore this single misspelling instance using an inline code comment",
    " - `" + commandPrefix + " ignore word` will ignore all misspellings of `" + suggestion.word + "` by adding it to the ignored words list",
    " - `" + commandPrefix + " ignore line` will ignore all misspellings on line " + suggestion.lineNumber + " using an inline code comment",
    " - `" + commandPrefix + " ignore file` will add `" + suggestion.path + "` to the ignored files list",
    " - `" + commandPrefix + " ignore ext` will add `*." + suggestion.path.split(".").pop() + "` to the ignored files list",
    " - `" + commandPrefix + " ignore dir` will add `" + suggestion.path.split("/").splice(0, -1).join("/") + "/*` to the ignored files list",
    " - `" + commandPrefix + " ignore <pattern>` will add a custom file path pattern to the ignored files list",
    "",
    "</details>"
  ].join("\n");
}
