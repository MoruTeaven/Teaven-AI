import { v7 as uuidv7 } from "uuid";

export function createId(prefix: string): string {
  return `${prefix}_${uuidv7()}`;
}
