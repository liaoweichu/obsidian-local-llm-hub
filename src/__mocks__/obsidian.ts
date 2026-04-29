// Minimal obsidian mock for unit tests
export class App {}
export class TFile {
  path = "";
  name = "";
  extension = "";
  basename = "";
  stat = { size: 0, mtime: 0, ctime: 0 };
}
export class TFolder {
  path = "";
  name = "";
  children: Array<TFile | TFolder> = [];
}
export function requestUrl(_options: unknown): Promise<unknown> {
  throw new Error("requestUrl is not available in tests");
}
