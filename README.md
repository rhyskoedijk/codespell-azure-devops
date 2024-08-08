# Codespell Azure DevOps Extension

This is the unofficial [codespell](https://github.com/codespell-project/codespell) extension for [Azure DevOps](https://azure.microsoft.com/en-gb/services/devops/). It will allow you to run codespell inside a build pipeline and is accessible [here in the Visual Studio marketplace](https://marketplace.visualstudio.com/items?itemName=rhyskoedijk.codespell).

## Usage

Add a configuration file stored at `.codespellrc` conforming to the [official spec](https://github.com/codespell-project/codespell?tab=readme-ov-file#using-a-config-file).
To use in a YAML pipeline:

```yaml
- task: codespell@1
```

## Development Guide

### Prepare Environment
```bash
npm install
```

### Build
```bash
tsc
```

### Publish
```bash
tfx extension create --manifest-globs vss-extension.json --rev-version
```