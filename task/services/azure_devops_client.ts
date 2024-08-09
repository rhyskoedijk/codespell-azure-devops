import * as azdev from "azure-devops-node-api";
import { GitPullRequestCommentThread, Comment } from "azure-devops-node-api/interfaces/GitInterfaces";

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

  public async processCorrectionsForPullRequest(options: {
    pullRequestId: number,
    corrections: IFileCorrection[]
  }) {
    await this.processExistingCorrectionsThreads(options);
    await this.processNewCorrectionsThreads(options);
  }

  private async processExistingCorrectionsThreads(options: {
    pullRequestId: number,
    corrections: IFileCorrection[]
  }) {
    let userId = await this.getUserId();

    let git = await this.connection.getGitApi();
    await git.getThreads(this.repositoryId, options.pullRequestId, this.project).then(async (threads) => {
      threads.forEach(thread => {
        let correction = options.corrections.find(correction => threadIsForCorrection(userId, thread, correction));
        if (!correction) {
          // TODO: Set threads to "fixed" if the correction has been resolved
          return;
        }

        console.debug(`Processing existing thread ${thread.id} for correction:`, correction);
        thread.comments?.forEach(async (comment) => {
          if (correction && comment.author?.id !== userId) {
            await this.processUserCommandFromComment({
              pullRequestId: options.pullRequestId,
              thread: thread,
              comment: comment,
              correction: correction
            });
          }
        });

      });
    });
  }

  private async processNewCorrectionsThreads(options: {
    pullRequestId: number,
    corrections: IFileCorrection[]
  }) {
    let userId = await this.getUserId();
    let git = await this.connection.getGitApi();

    let newCorrectionsToSuggest = await git.getThreads(this.repositoryId, options.pullRequestId, this.project).then(async (threads) => {
      return options.corrections.filter(correction => {
        return !threads.some(thread => threadIsForCorrection(userId, thread, correction));
      });
    });

    newCorrectionsToSuggest.forEach(async (correction) => {
      console.debug("Creating suggestion for correction:", correction);
      let correctionLineStartOffset = correction.lineText.indexOf(correction.word);
      let correctionLineEndOffset = correctionLineStartOffset + correction.word.length;
      await git.createThread({
        comments: [{
          parentCommentId: 0,
          commentType: 1,
          content: correction.suggestions.map(s => "```suggestion\n" + s + "\n```").join("\n")
        }],
        status: 1,
        threadContext: {
          filePath: correction.file,
          rightFileStart: {
            line: correction.lineNumber,
            offset: correctionLineStartOffset
          },
          rightFileEnd: {
            line: correction.lineNumber,
            offset: correctionLineEndOffset + correction.word.length
          }
        }
      }, this.repositoryId, options.pullRequestId, this.project);
    });
  }

  private async processUserCommandFromComment(options: {
    pullRequestId: number,
    thread: GitPullRequestCommentThread,
    comment: Comment,
    correction: IFileCorrection
  }) {
    // If comment is not a command, ignore it
    if (!options.comment.content?.startsWith(this.commandPrefix)) {
      return;
    }

    // If comment was already reacted to by our user, ignore it
    if (options.comment.usersLiked?.some(user => user.id === this.userId)) {
      return;
    }

    // Parse the command
    let command: string = options.comment.content.substr(this.commandPrefix.length).trim();
    console.log(`Processing user command '${command}'`);

    // Handle the command
    // TODO: Implement this...

    // React to the comment so that we don't process it again
    if (options.thread.id && options.comment.id) {
      let git = await this.connection.getGitApi();
      await git.createLike(this.repositoryId, options.pullRequestId, options.thread.id, options.comment.id, this.project);
    }
  }

  private async getUserId(): Promise<string | null> {
    return (this.userId ||= (await this.connection.connect()).authenticatedUser?.id || null);
  }
}

function threadIsForCorrection(userId: string | null, thread: GitPullRequestCommentThread, correction: IFileCorrection) {
  let correctionLineStartOffset = correction.lineText.indexOf(correction.word);
  let correctionLineEndOffset = correctionLineStartOffset + correction.word.length;
  return thread.isDeleted === false && // is not deleted
    thread.status === 1 && // is active
    thread.comments?.some(comment => comment.author?.id === userId) && // has a comment from the user
    thread.threadContext?.filePath === correction.file &&
    thread.threadContext?.rightFileStart?.line === correction.lineNumber &&
    thread.threadContext?.rightFileStart?.offset === correctionLineStartOffset &&
    thread.threadContext?.rightFileEnd?.line === correction.lineNumber &&
    thread.threadContext?.rightFileEnd?.offset === correctionLineEndOffset + correction.word.length
}
