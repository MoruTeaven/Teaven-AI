// 构建完成后记录源码版本到 dist/BUILD_STAMP。
//
// deploy/start.sh 启动前比对「当前 git HEAD」与「构建时记录的 stamp」，
// 不一致就拒绝启动。这样「git pull 之后忘记 npm run build」会立刻暴露成启动失败，
// 而不是静默跑旧 bundle。
//
// stamp 约定：能取到 git 就写完整 commit SHA，取不到（无 git / 非 git 仓库）写 nogit，
// 两端都退化为 nogit 时校验自然通过，不阻塞构建。
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

function readHead() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "nogit";
  }
}

const stamp = readHead() || "nogit";
writeFileSync("dist/BUILD_STAMP", `${stamp}\n`);
console.log(`build stamp: ${stamp}`);
