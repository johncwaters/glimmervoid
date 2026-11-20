import { deny, readHookInput } from "./hook-input.mjs";

const GIT_WORD = String.raw`(^|[;&|(\x60\s'"/])git['"]?`;
const GIT_OPTION = String.raw`\s+(-[Cc]\s*\S+|--(git-dir|work-tree|namespace|exec-path)(=|\s+)\S+|-{1,2}[\w-]+(=\S+)?)`;
const COMMITTING_SUBCOMMAND = String.raw`\s+['"]?(commit|push|ci)\b`;
const RAW_GIT_COMMIT_OR_PUSH = new RegExp(`${GIT_WORD}(${GIT_OPTION})*${COMMITTING_SUBCOMMAND}`);
const GIT_ALIAS_DEFINITION = /\balias\.\S+(=|\s+)['"]?!?\s*(git\s+)?(commit|push)\b/;
const BLESSED_GIT_CALL = new RegExp(String.raw`(^|[;&|(\s])SHIP_LANDING_RECOVERY=1\s+git(${GIT_OPTION})*${COMMITTING_SUBCOMMAND}`, "g");

const input = readHookInput();
if (input === null || input.tool.kind !== "shell" || typeof input.tool.command !== "string") process.exit(0);
const command = input.tool.command;
const unblessedCommand = command.replace(BLESSED_GIT_CALL, " ");
if (!RAW_GIT_COMMIT_OR_PUSH.test(unblessedCommand) && !GIT_ALIAS_DEFINITION.test(unblessedCommand)) process.exit(0);
deny("Land through the landing skill of the ship pack: its land.ts commits and pushes exactly the tree a review gate stamped. Inside landing's recovery steps only, prefix the git command with SHIP_LANDING_RECOVERY=1.");
