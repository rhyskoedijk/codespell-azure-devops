import * as azdev from "azure-devops-node-api";
import { GitPullRequestCommentThread, Comment, CommentThreadStatus, CommentType, VersionControlChangeType, ItemContentType } from "azure-devops-node-api/interfaces/GitInterfaces";

export interface IFileCorrection {
  file: string;
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

  constructor(organizationUri: string, project: string, repositoryId: string, accessToken: string) {
    this.organizationUri = organizationUri;
    this.project = project;
    this.repositoryId = repositoryId;
    this.connection = new azdev.WebApi(
      organizationUri,
      azdev.getPersonalAccessTokenHandler(accessToken)
    );
  }

  public async commitCorrectionsToPullRequest(options: {
    pullRequestId: number,
    corrections: IFileCorrection[]
  }) {
    let git = await this.connection.getGitApi();

    // Get pull request details
    let pullRequest = await git.getPullRequest(this.repositoryId, options.pullRequestId, this.project);
    if (!pullRequest) {
      throw new Error(`Could not find pull request with ID ${options.pullRequestId}`);
    }
    
    // Commit local changes to the pull request source branch
    let changedFiles = options.corrections.map(correction => correction.file);
    await git.createPush({
      refUpdates: [{
        name: pullRequest.sourceRefName
      }],
      commits: [{
        comment: "Codespell corrections",
        changes: changedFiles.map(f => ({
          changeType: VersionControlChangeType.Edit,
          item: {
            path: f
          },
          newContent: {
            content: "This is a test",
            contentType: ItemContentType.RawText
          }
        }))
      }]
    }, this.repositoryId, this.project);
  }

  public async suggestCorrectionsToPullRequest(options: {
    pullRequestId: number,
    corrections: IFileCorrection[]
  }) {
    let userId = await this.getUserId();
    let git = await this.connection.getGitApi();

    // Find the most recent iteration ID for the PR
    let latestIterationId = await git.getPullRequestIterations(this.repositoryId, options.pullRequestId, this.project).then(iterations => {
      return Math.max(...iterations.map(i => i.id || 1));
    });
    if (!latestIterationId) {
      throw new Error("Could not find the latest iteration ID for the PR");
    }

    // Find all added or edited files paths in the PR
    let addedOrEditedFilePaths = await git.getPullRequestIterationChanges(this.repositoryId, options.pullRequestId, latestIterationId, this.project, 2000).then(changes => {
      return changes?.changeEntries
        ?.filter(c => c?.changeType === VersionControlChangeType.Add || c?.changeType === VersionControlChangeType.Edit)
        ?.flatMap(c => c?.item?.path);
    });

    // Find all active threads in the PR
    let activeThreads = (await git.getThreads(this.repositoryId, options.pullRequestId, this.project))
      .filter(thread => !thread.isDeleted && thread.status === CommentThreadStatus.Active);

    // Find corrections that relevant to the PR file changes and that have not been suggested yet
    let correctionsToSuggest = options.corrections.filter(correction => {
      let isFileAddedOrEdited = addedOrEditedFilePaths?.some(path => path === correction.file);
      let hasActiveSuggestionThread = activeThreads.some(thread => isThreadForCorrection(userId, thread, correction));
      return isFileAddedOrEdited && !hasActiveSuggestionThread;
    });

    // Resolve threads for corrections that have been fixed
    activeThreads.forEach(thread => {
      let correction = options.corrections.find(correction => isThreadForCorrection(userId, thread, correction));
      if (!correction && thread.id) {
        console.info(`Closing correction thread as fixed [pr: ${options.pullRequestId}, thread: ${thread.id}]`);
        git.updateThread({
          status: CommentThreadStatus.Fixed
        }, this.repositoryId, options.pullRequestId, thread.id, this.project);
      }
    });

    correctionsToSuggest.forEach(async (correction) => {
      console.info("Creating suggestion comment for correction:", correction);
      let correctionLineStartOffset = correction.lineText.indexOf(correction.word);
      let correctionLineEndOffset = correctionLineStartOffset + correction.word.length;
      await git.createThread({
        comments: [{
          commentType: CommentType.CodeChange,
          content: (
            `Misspelling of '${correction.word}'\n` +
            correction.suggestions.map(s => "```suggestion\n" + s + "\n```").join("\n") +
            commandHelpText(this.commandPrefix, correction)
          )
        }],
        status: CommentThreadStatus.Active,
        threadContext: {
          filePath: correction.file,
          rightFileStart: {
            line: correction.lineNumber,
            offset: correctionLineStartOffset
          },
          rightFileEnd: {
            line: correction.lineNumber,
            offset: correctionLineEndOffset
          }
        },
        properties: {
          "codespell:correction": {
            "$type": "System.String",
            "$value": JSON.stringify(correction)
          }
        }
      }, this.repositoryId, options.pullRequestId, this.project);
    });
  }

  public async processUserCommandsInPullRequest(options: {
    pullRequestId: number
  }) {
    let git = await this.connection.getGitApi();
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

    // Parse the correction info from the thread properties
    let correction = getThreadCorrectionProperty(options.thread);
    if (!correction) {
      return;
    }

    console.log(`Processing command '${command.join(" ")}' in [pr: ${options.pullRequestId}, thread: ${options.thread.id}, comment: ${options.comment.id}] for correction:`, correction);
    switch (command[0]) {
      case "ignore":
        let ignoreTarget = command.length > 1 ? command[1] : "this";
        await this.processIgnoreCommand(ignoreTarget, options);
        break;
      default:
        console.warn(`Unknown command '${command[0]}'`);
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
}

function getThreadCorrectionProperty(thread: GitPullRequestCommentThread): IFileCorrection | null {
  let correction = thread.properties?.["codespell:correction"]?.["$value"];
  if (!correction) {
    return null;
  }
  return JSON.parse(correction);
}

function isThreadForCorrection(userId: string | null, thread: GitPullRequestCommentThread, correction: IFileCorrection): boolean {
  let threadCorrection = getThreadCorrectionProperty(thread);
  return (
    thread.isDeleted === false && // is not deleted
    thread.status === CommentThreadStatus.Active && // is active
    thread.comments?.some(comment => comment.author?.id === userId) && // has a comment from our user id
    threadCorrection && // has a codespell correction property
    threadCorrection.file === correction.file && // is for the same file
    threadCorrection.lineNumber === correction.lineNumber && // is for the same line
    threadCorrection.word === correction.word // is for the same word
  ) || false;
}

function commandHelpText(commandPrefix: string, correction: IFileCorrection): string {
  return [
    "<details>",
    "<summary>🛠️ Codespell commands and options</summary>",
    "",
    "You can trigger Codespell actions by replying to this comment with any of the following commands:",
    " - `" + commandPrefix + " ignore this` will ignore this single misspelling instance using an inline code comment",
    " - `" + commandPrefix + " ignore word` will ignore all misspellings of `" + correction.word + "` by adding it to the ignored words list",
    " - `" + commandPrefix + " ignore line` will ignore all misspellings on line " + correction.lineNumber + " using an inline code comment",
    " - `" + commandPrefix + " ignore file` will add `" + correction.file + "` to the ignored files list",
    " - `" + commandPrefix + " ignore ext` will add `*." + correction.file.split(".").pop() + "` to the ignored files list",
    " - `" + commandPrefix + " ignore dir` will add `" + correction.file.split("/").splice(0, -1).join("/") + "/*` to the ignored files list",
    " - `" + commandPrefix + " ignore <pattern>` will add a custom file path pattern to the ignored files list",
    "",
    "</details>"
  ].join("\n");
}
