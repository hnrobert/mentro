import { AddFtsFilename1766000002000 } from "./1766000002000-AddFtsFilename";
import { FtsContentful1766000001000 } from "./1766000001000-FtsContentful";
import { IndexLog1766000003000 } from "./1766000003000-IndexLog";
import { KnowledgeBase1787780185568 } from "./1787780185568-KnowledgeBase";
import { Init1766000000000 } from "./1766000000000-Init";

// The DataSource option is cast at the consumption site (see data-source):
// typeorm@1 expects `(string | Function)[]`, which migration classes
// satisfy at runtime but not structurally.
export const migrations = [
  Init1766000000000,
  FtsContentful1766000001000,
  AddFtsFilename1766000002000,
  IndexLog1766000003000,
  KnowledgeBase1787780185568,
];
