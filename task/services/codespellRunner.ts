import { debug, warning, error } from "azure-pipelines-task-lib/task"
import { which, tool } from "azure-pipelines-task-lib/task"
import { ToolRunner } from "azure-pipelines-task-lib/toolrunner"
import { IFile, IFileSuggestion } from "./azureDevOpsClient";
import { Stream } from "stream";

export interface ICodeSpellResult {
    returnCode: number;
    fixed: IFile[];
    suggestions: IFileSuggestion[];
}

export class CodespellRunner {
    private debug: boolean;

    constructor(debug: boolean) {
        this.debug = debug;
    }

    // Install codespell if not already installed
    public async installIfMissing(): Promise<void> {
        if (which("codespell", false)) {
            return;
        }

        debug("Codespell was not found, installing via `pip install`...");
        const pipRunner: ToolRunner = tool(which("pip", true));
        pipRunner.arg(["install", "codespell", "chardet"]);
        pipRunner.execSync({
            silent: !this.debug
        });
    }

    // Run codespell
    public async run(options: {
        writeChanges: boolean,
        postFixCommand?: string
    }): Promise<ICodeSpellResult> {

        await this.installIfMissing();

        const codespellRunner = tool(which("codespell", true));
        const codespellArguments = ["--quiet-level", "2", "--context", "0"];
        if (options.writeChanges) {
            codespellArguments.push("--write-changes");
        }
        codespellRunner.arg(codespellArguments);

        let lineContext = '';
        const fixedFiles: IFile[] = [];
        const suggestions: IFileSuggestion[] = [];
        codespellRunner.on("stdout", (data: Buffer) => {
            data.toString().split(/[\r\n]+/).forEach((line: string) => {
                const suggestionMatch = line.match(/(.*):(\d+):(.*)==>(.*)/i);
                if (suggestionMatch) {
                    suggestions.push({
                        path: suggestionMatch[1].trim(),
                        lineNumber: parseInt(suggestionMatch[2]),
                        lineText: lineContext.substring(1),
                        word: suggestionMatch[3].trim(),
                        suggestions: suggestionMatch[4].trim().split(',').map(s => s.trim())
                    });
                }
                lineContext = line;
            });
        });
        codespellRunner.on("stderr", (data: Buffer) => {
            data.toString().split(/[\r\n]+/).forEach((line: string) => {
                const fixedFileMatch = line.match(/FIXED\: (.*)/i);
                if (fixedFileMatch) {
                    fixedFiles.push({
                        path: fixedFileMatch[1].trim()
                    });
                }
                const warningMatch = line.match(/WARNING\: (.*)/i);
                if (warningMatch) {
                    warning(warningMatch[1].trim());
                }
                const errorMatch = line.match(/ERROR\: (.*)/i);
                if (errorMatch) {
                    error(errorMatch[1].trim());
                }
            });
        });

        console.info("Running codespell...");
        const returnCode = await codespellRunner.execAsync({
            silent: !this.debug,
            ignoreReturnCode: true,
            failOnStdErr: false,
        });

        // If anything was changed, run the post-fix command (if configured)
        if (options.postFixCommand && fixedFiles.length > 0) {
            console.info("Running post-fix commands...");
            await this.runPostFixCommand(options.postFixCommand);
        }

        // TODO: "git diff --name-only", append to fixedFiles
        
        // Tell the user what we found
        const noMisspellingsFound = (suggestions.length === 0 && fixedFiles.length === 0);
        if (noMisspellingsFound) {
            console.info("No misspellings found.");
        }
        if (fixedFiles.length > 0) {
            console.info(`Fixed misspellings in ${fixedFiles.length} files:`);
            fixedFiles.forEach(f => console.info(` - ${f.path}`));
        }
        if (suggestions.length > 0) {
            warning(`Found ${suggestions.length} misspelling(s) ${options.writeChanges ? "that could not be automatically corrected" : ""}:`);
            suggestions.forEach(c => warning(` - ${c.path}:${c.lineNumber} ${c.word} ==> ${c.suggestions.join(", ")}`));
        }

        return {
            returnCode: returnCode,
            fixed: fixedFiles,
            suggestions: suggestions
        };
    }

    private async runPostFixCommand(postFixCommand: string): Promise<void> {
        const commands = postFixCommand.split("\n").map(c => c.trim());
        for (const command of commands) {
            const toolName = command.split(" ").map(c => c.trim())[0];
            if (!which(toolName)) {
                warning(`Post-fix command tool \`${toolName}\` not found in PATH. Skipping command.`);
                return;
            }

            console.info(`Running \`${command}\`...`);
            const toolRunner: ToolRunner = tool(which(toolName, true));
            toolRunner.arg(command.substring(toolName.length).trim());
            await toolRunner.execAsync();
        };
    }
}