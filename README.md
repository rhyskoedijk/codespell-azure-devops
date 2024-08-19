<h1 align="center" style="display:flex; align-items:top; gap:1rem">
    <picture>
        <img src="images/icon.png" alt="Dependabot" width="32" />
    </picture>
    <span>Codespell Azure DevOps Extension</span>
</h1>

This extension runs [codespell](https://github.com/codespell-project/codespell) over your code. Any misspellings can be automatically fixed via a commit, or suggested using a pull request suggestion comment.

## Install

Install the extension from the [Visual Studio marketplace](https://marketplace.visualstudio.com/items?itemName=rhyskoedijk.codespell).

## Usage

## Basic usage
Set the pipeline variable `codespell` to `true` in any pipelines triggered as part of your pull request build validation. The codespell check will run immediately after source code checkout, before any build steps. 

In YAML pipelines:
```yaml
variables:
  - name: codespell
    value: true
```

Then add a `.codespellrc` configuration file to the root directory of your repository. Refer to [Azure DevOps configuration file](#azure-devops-configuration-file) for more on how to configure codespell.


## Advanced usage
If you need more granular control over when and where codespell runs within your pipeline, you can add it as a step. It's recommended to run codespell as early as possible, ideally immediately after source code checkout to avoid doing unesscary build tasks when missepllings are found.

In YAML pipelines:

```yaml
jobs:
- job: build
  steps:
  - checkout: self
  - task: codespell@1
  # your build tasks here...
```

 It is also recommended to add a `.codespellrc`  configuration file to the root directory of your repository. Refer to [Azure DevOps configuration file](#azure-devops-configuration-file) for more on how to configure codespell.

Task configuration options set within the pipeline override any config options in `.codespellrc`.

## Azure DevOps configuration file
In addition to all built-in [codespell configuration file options](https://github.com/codespell-project/codespell?tab=readme-ov-file#using-a-config-file), these additional configuration are supported by this extension:

```ini
[codespell]
; Your codespell config goes here...
; https://github.com/codespell-project/codespell?tab=readme-ov-file#using-a-config-file

[devops]
; These options are specific to the Azure DevOps extension and have no effect if codespell is run manually.

; When misspellings are found, suggested fixes will be committed directly to the source branch of the pull request associated with the run. This setting is ignored if the pipeline run is not in the context of a pull request.
commit-suggestions = 

; When misspellings are found, suggested fixes will be added as comments to the pull request associated with the run. This setting is ignored if the pipeline run is not in the context of a pull request.
comment-suggestions = 

; Additional command(s) to run after fixing misspellings. This can be used to run code linting tools, if required.
post-fix-command = 

; When misspellings are found, the pipeline will fail with error "X misspellings found". By default, misspellings are raised as warnings only.
fail-on-misspelling = 

; Log additional information to assist with debugging
debug = 
```

## How to phase in codespell to existing projects

Introducing spelling checks to an existing project can be distruptive if there are a lot of existing missepllings. This is a step-by-step guide on how to fix existing missepllings via a pull request and then guard against new missepllings in future pull requests.

### Enable codespell in your build validation pipeline
...

### Create a new feature branch
...

### Create the initial `.codespellrc` config file
...

### Run codespell in "warning only" mode
...

### Refine your skip and ignore rules
...

### Run codespell in "commit and comment" mode
...

### Apply suggestions
...

### Merge the pull request
...
