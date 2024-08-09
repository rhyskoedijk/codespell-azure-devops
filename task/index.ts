import * as tl from "azure-pipelines-task-lib/task"
import { ToolRunner } from "azure-pipelines-task-lib/toolrunner"
import { AzureDevOpsClient, IFileCorrection } from "./services/azure_devops_client";

async function run() {
    try {

        let isDebug = tl.getBoolInput("System.Debug", false);

        let organizationUri = tl.getVariable("System.CollectionUri");
        if (!organizationUri) {
            throw new Error("'System.CollectionUri' is not set");
        }

        let project = tl.getVariable("System.TeamProject");
        if (!project) {
            throw new Error("'System.TeamProject' is not set");
        }

        let repositoryId = tl.getVariable("Build.Repository.ID");
        if (!repositoryId) {
            throw new Error("'Build.Repository.ID' is not set");
        }

        let accessToken = tl.getVariable("System.AccessToken");
        if (!accessToken) {
            throw new Error("'System.AccessToken' is not set");
        }

        let pullRequestId = parseInt(tl.getVariable("System.PullRequest.PullRequestId") || "0");
        if (pullRequestId > 0) {
            console.log('Running for PR #', pullRequestId);
        }

        // Install codespell if not already installed
        if (!tl.which("codespell", false)) {
            console.log('Codespell was not found, installing now...');
            let pipRunner: ToolRunner = tl.tool(tl.which("pip", true));
            pipRunner.arg(["install", "codespell"]);
            pipRunner.execSync({
                silent: !isDebug
            })

        }

        // Run codespell
        console.log('Running codespell...');
        let codeSpellRunner: ToolRunner = tl.tool(tl.which("codespell", true));
        codeSpellRunner.arg(["--check-filenames", "-C", "0"]);
        let codeSpellResult = codeSpellRunner.execSync({
            silent: !isDebug
        })

        // Parse codespell corrections
        let lastLine = '';
        let corrections: IFileCorrection[] = [];
        codeSpellResult.stdout.split(/[\r\n]+/).forEach((line: string) => {
            let match = line.match(/(.*):(\d+):(.*)==>(.*)/);
            if (match) {
                corrections.push({
                    file: match[1].trim().replace(/^\.+/g, ""),
                    lineNumber: parseInt(match[2]),
                    lineText: lastLine.substring(1),
                    word: match[3].trim(),
                    suggestions: match[4].trim().split(',').map(s => s.trim())
                });
            }
            lastLine = line;
        });

        console.debug('Detected corrections:', corrections);

        // Process codespell corrections
        if (pullRequestId > 0) {
            let ado: AzureDevOpsClient = new AzureDevOpsClient(organizationUri, project, repositoryId, accessToken);
            await ado.processCorrectionsForPullRequest({
                pullRequestId: pullRequestId,
                corrections: corrections
            });
        }
    }
    catch (err: any) {
        tl.setResult(tl.TaskResult.Failed, err.message);
    }
}

run();
