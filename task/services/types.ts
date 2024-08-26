
export interface IFile {
  path: string;
}

export interface IFileSuggestion extends IFile {
  lineNumber: number;
  lineText: string;
  word: string;
  suggestions: string[];
}
