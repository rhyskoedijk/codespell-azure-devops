import * as tl from "azure-pipelines-task-lib/task"
import { ToolRunner } from "azure-pipelines-task-lib/toolrunner"
import { AzureDevOpsClient, IFileCorrection } from "./services/azure_devops_client";

async function run() {
    try {

        let commitChanges = tl.getBoolInput("commitChanges", false);
        let suggestChanges = tl.getBoolInput("suggestChanges", false);
        let failOnMisspelling = tl.getBoolInput("failOnMisspelling", false);

        let debug = tl.getVariable("System.Debug")?.toLowerCase() === "true";

        let accessToken = tl.getVariable("System.AccessToken");
        if (!accessToken) {
            throw new Error("Required variable 'System.AccessToken' is not set");
        }

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
                console.log(`Any misspelling suggestions will be committed directly to PR #${pullRequestId}`);
            } else if (suggestChanges) {
                console.log(`Any misspelling suggestions will be raised as comments in PR #${pullRequestId}`);
            }
        }

        let ado: AzureDevOpsClient = new AzureDevOpsClient(organizationUri, project, repositoryId, accessToken);

        // Process any user commands found in pull request comments (e.g. "@codespell ignore this") 
        // This ensures that `.codespellrc` is up to date before we run codespell
        if (pullRequestId > 0 && suggestChanges) {
            console.log(`Processing user commands in PR comments...`);
            await ado.processUserCommandsInPullRequest({
                pullRequestId: pullRequestId
            });
        }

        // Install codespell if not already installed
        if (!tl.which("codespell", false)) {
            console.log('Codespell was not found, installing now...');
            let pipRunner: ToolRunner = tl.tool(tl.which("pip", true));
            pipRunner.arg(["install", "codespell"]);
            pipRunner.execSync({
                silent: !debug
            });
        }

        // Run codespell
        console.log('Running codespell...');
        let codeSpellRunner: ToolRunner = tl.tool(tl.which("codespell", true));
        let codeSpellArguments = ["--quiet-level", "0", "--context", "0", "--hard-encoding-detection"];
        if (commitChanges) {
            codeSpellArguments.push("--write-changes");
        }
        codeSpellRunner.arg(codeSpellArguments);
        let codeSpellResult = codeSpellRunner.execSync({
            silent: !debug
        })
        console.debug(`codespell exited with code ${codeSpellResult.code}.`);

        // Parse codespell output
        let lineContext = '';
        let corrections: IFileCorrection[] = [];
        codeSpellResult.stdout.split(/[\r\n]+/).forEach((line: string) => {
            let match = line.match(/(.*):(\d+):(.*)==>(.*)/);
            if (match) {
                corrections.push({
                    file: match[1].trim().replace(/^\.+/g, ""),
                    lineNumber: parseInt(match[2]),
                    lineText: lineContext.substring(1),
                    word: match[3].trim(),
                    suggestions: match[4].trim().split(',').map(s => s.trim())
                });
            }
            lineContext = line;
        });

        // Tell the user what we found
        console.info(`Found ${corrections.length} misspellings.`);
        console.info(corrections.map(c => `${c.file}:${c.lineNumber} ${c.word} ==> ${c.suggestions.join(", ")}`).join("\n"));

        // If anything was found, commit or suggest corrections on the PR (if configured)
        if (corrections.length > 0 && pullRequestId > 0) {
            if (commitChanges) {
                console.log(`Committing codespell corrections to PR...`);
                await ado.commitCorrectionsToPullRequest({
                    pullRequestId: pullRequestId,
                    corrections: corrections
                });

            } else if (suggestChanges) {
                console.log(`Suggesting codespell corrections to PR...`);
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
