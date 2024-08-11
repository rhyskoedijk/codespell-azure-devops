import * as tl from "azure-pipelines-task-lib/task"
import { debug, warning, error } from "azure-pipelines-task-lib/task"
import { ToolRunner } from "azure-pipelines-task-lib/toolrunner"
import { AzureDevOpsClient, IFile, IFileCorrection } from "./services/azureDevOpsClient";
import fs from "fs";

async function run() {
    try {

        let commitChanges = tl.getBoolInput("commitChanges", false);
        let suggestChanges = tl.getBoolInput("suggestChanges", false);
        let failOnMisspelling = tl.getBoolInput("failOnMisspelling", false);

        let isDebug = tl.getVariable("System.Debug")?.toLowerCase() === "true";

        let organizationUri = tl.getVariable("System.CollectionUri");
        if (!organizationUri) {
            throw new Error("Required variable 'System.CollectionUri' is not set");
        }

        let project = tl.getVariable("System.TeamProject");
        if (!project) {
            throw new Error("Required variable 'System.TeamProject' is not set");
        }

        let repositoryId = tl.getVariable("Build.Repository.ID");
        if (!repositoryId) {
            throw new Error("Required variable 'Build.Repository.ID' is not set");
        }

        let pullRequestId = parseInt(tl.getVariable("System.PullRequest.PullRequestId") || "0");
        if (pullRequestId > 0) {
            if (commitChanges) {
                console.info(`Any misspelling suggestions will be committed directly to PR #${pullRequestId}`);
            } else if (suggestChanges) {
                console.info(`Any misspelling suggestions will be raised as comments in PR #${pullRequestId}`);
            }
        }

        let ado: AzureDevOpsClient = new AzureDevOpsClient(organizationUri, project, repositoryId);

        // Process any user commands found in pull request comments (e.g. "@codespell ignore this") 
        // This ensures that `.codespellrc` is up to date before we run codespell
        if (pullRequestId > 0 && suggestChanges) {
            console.info("Checking PR comments for new commands that need processing...");
            await ado.processUserCommandsInPullRequest({
                pullRequestId: pullRequestId
            });
        }

        // Install codespell if not already installed
        if (!tl.which("codespell", false)) {
            debug("Codespell was not found, installing via `pip install`...");
            let pipRunner: ToolRunner = tl.tool(tl.which("pip", true));
            pipRunner.arg(["install", "codespell", "chardet"]);
            pipRunner.execSync({
                silent: !isDebug
            });
        }

        // Run codespell
        console.info("Running codespell...");
        let codeSpellRunner: ToolRunner = tl.tool(tl.which("codespell", true));
        let codeSpellArguments = ["--quiet-level", "2", "--context", "0", "--hard-encoding-detection"];
        if (commitChanges) {
            codeSpellArguments.push("--write-changes");
        }
        codeSpellRunner.arg(codeSpellArguments);
        let codeSpellResult = codeSpellRunner.execSync({
            silent: !isDebug
        })
        debug(`codespell exited with code ${codeSpellResult.code}.`);

        // Parse codespell output
        let lineContext = '';
        let fixedFiles: IFile[] = [];
        let corrections: IFileCorrection[] = [];
        codeSpellResult.stdout.split(/[\r\n]+/).forEach((line: string) => {
            let correctionMatch = line.match(/(.*):(\d+):(.*)==>(.*)/i);
            if (correctionMatch) {
                corrections.push({
                    filePath: correctionMatch[1].trim().replace(/^\.+/g, ""),
                    lineNumber: parseInt(correctionMatch[2]),
                    lineText: lineContext.substring(1),
                    word: correctionMatch[3].trim(),
                    suggestions: correctionMatch[4].trim().split(',').map(s => s.trim())
                });
            }
            lineContext = line;
        });
        codeSpellResult.stderr.split(/[\r\n]+/).forEach((line: string) => {
            let fixedFileMatch = line.match(/FIXED\: (.*)/i);
            if (fixedFileMatch) {
                fixedFiles.push({
                    path: fixedFileMatch[1].trim().replace(/^\.+/g, ""),
                    contents: fs.readFileSync(fixedFileMatch[1])
                });
            }
            let warningMatch = line.match(/WARNING\: (.*)/i);
            if (warningMatch) {
                warning(warningMatch[1].trim());
            }
            let errorMatch = line.match(/ERROR\: (.*)/i);
            if (errorMatch) {
                error(errorMatch[1].trim());
            }
        });

        // Tell the user what we found
        if (corrections.length > 0)
        {
            warning(`Found ${corrections.length} misspellings:`);
            corrections.forEach(c => warning(` - ${c.filePath}:${c.lineNumber} ${c.word} ==> ${c.suggestions.join(", ")}`));
        }
        if (fixedFiles.length > 0)
        {
            console.info(`Fixed misspellings in ${fixedFiles.length} files:`);
            fixedFiles.forEach(f => console.info(` - ${f.path}`));
        }

        // If anything was found, commit or suggest corrections on the PR (if configured)
        if (pullRequestId > 0) {
            if (commitChanges && fixedFiles.length > 0) {
                await ado.commitCorrectionsToPullRequest({
                    pullRequestId: pullRequestId,
                    fixedFiles: fixedFiles
                });

            }
            if (suggestChanges) {
                await ado.suggestCorrectionsToPullRequest({
                    pullRequestId: pullRequestId,
                    corrections: corrections
                });
            }
        }

        tl.setResult(
            (corrections.length === 0 || !failOnMisspelling) ? tl.TaskResult.Succeeded : tl.TaskResult.Failed,
            `Found ${corrections.length} misspellings.`
        );
    }
    catch (err: any) {
        tl.setResult(tl.TaskResult.Failed, err.message);
    }
}

run();
