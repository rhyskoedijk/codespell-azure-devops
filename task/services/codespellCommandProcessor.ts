import { GitPullRequestCommentThread, Comment } from "azure-devops-node-api/interfaces/GitInterfaces";
import { IFile, IFileSuggestion } from "./types";
import { warning } from "azure-pipelines-task-lib";

export class CodespellCommandProcessor {

  readonly commandPrefix = "@codespell";

  public getCommandHelpTextFor(suggestion: IFileSuggestion): string {
    return [
      "<details>",
      "<summary>🛠️ Codespell commands and options</summary>",
      "",
      "You can trigger Codespell actions by replying to this comment with any of the following commands:",
      " - `" + this.commandPrefix + " ignore this` will ignore this single misspelling instance using an inline code comment",
      " - `" + this.commandPrefix + " ignore word` will ignore all misspellings of `" + suggestion.word + "` by adding it to the ignored words list",
      " - `" + this.commandPrefix + " ignore line` will ignore all misspellings on line " + suggestion.lineNumber + " using an inline code comment",
      " - `" + this.commandPrefix + " ignore file` will add `" + suggestion.path + "` to the ignored files list",
      " - `" + this.commandPrefix + " ignore ext` will add `*." + suggestion.path.split(".").pop() + "` to the ignored files list",
      " - `" + this.commandPrefix + " ignore dir` will add `" + suggestion.path.split("/").splice(0, -1).join("/") + "/*` to the ignored files list",
      " - `" + this.commandPrefix + " ignore <pattern>` will add a custom file path pattern to the ignored files list",
      "",
      "</details>"
    ].join("\n");
  }
  
  public async processCommands(options: {
    pullRequestId: number,
    thread: GitPullRequestCommentThread,
    comment: Comment,
    suggestion: IFileSuggestion
  }) : Promise<boolean> {
    let commandsWereHandled = false;

    // If the comment doesn't have a command prefix, ignore it
    if (!options.comment.content?.startsWith(this.commandPrefix)) {
      return commandsWereHandled;
    }

    // Parse the command
    const command: string[] = options.comment.content.substr(this.commandPrefix.length).trim().split(" ").map(c => c.trim().toLocaleLowerCase());
    if (command.length === 0) {
      return commandsWereHandled;
    }

    console.info(`Processing command '${command.join(" ")}' for suggestion:`, options.suggestion);
    switch (command[0]) {
      case "ignore":
        const ignoreTarget = command.length > 1 ? command[1] : "this";
        commandsWereHandled = await this.processIgnoreCommand(ignoreTarget, options);
        break;
      default:
        warning(`Unknown command '${command[0]}'`);
        break;
    }

    return commandsWereHandled;
  }

  private async processIgnoreCommand(ignoreTarget: string, options: {
    pullRequestId: number,
    thread: GitPullRequestCommentThread,
    comment: Comment
  }) : Promise<boolean> {
    // TODO: Implement this...
    throw new Error("Command not implemented");
    return false;
  }
}
