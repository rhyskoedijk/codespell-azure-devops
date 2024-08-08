import * as tl from "azure-pipelines-task-lib/task"
import { ToolRunner } from "azure-pipelines-task-lib/toolrunner"

 async function run() {
     try {
        /*
         const inputString: string | undefined = tl.getInput('samplestring', true);
         if (inputString == 'bad') {
             tl.setResult(tl.TaskResult.Failed, 'Bad input was given');
             return;
         }
         console.log('Hello', inputString);
         */

        let pullRequestId = tl.getVariable("System.PullRequest.PullRequestId");
        if (pullRequestId) {
            console.log('Running for PR #', pullRequestId);
        }
        
        console.log('Installing codespell..');
        let pipRunner: ToolRunner = tl.tool(tl.which("pip", true));
        pipRunner.arg(["install", "codespell"]);
        pipRunner.execSync();

        console.log('Running codespell...');
        let codespellOutput = '';
        let codeSpellRunner: ToolRunner = tl.tool(tl.which("codespell", true));
        codeSpellRunner.on('stdout', (data) => {
            codespellOutput += data.toString();
        });
        codeSpellRunner.on('stderr', (data) => {
            codespellOutput += data.toString();
        });
        codeSpellRunner.on('exit', (code) => {
            console.log('Codespell output:');
            console.log(codespellOutput);
        });
        codeSpellRunner.arg(["--check-filenames"]);
        codeSpellRunner.execSync();

     }
     catch (err:any) {
         tl.setResult(tl.TaskResult.Failed, err.message);
     }
 }

 run();
