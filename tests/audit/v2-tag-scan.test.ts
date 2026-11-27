// Mechanized native-v2 tag scan (audit routine, not CI-default).
//
// Native v2 (>= 2.8.0 floor) is certified on a construction, not on an upstream
// ordering contract: the engine's ONLY chain-breaking final allow is the
// plan-file guard, it fires only while plan mode is active, and the plugin
// closes every route by which plan mode can arm in a `kimi -p` session. That
// construction is an enumeration over one exact source tree, so it must be
// re-established for every kimi-code version before that version is appended to
// `KIMI_V2_RELEASES` (runtime/kimi-releases.ts). This file is that
// re-establishment, in symbol-level form. It cannot see semantic regressions
// (a new listener that performs a side effect and then vetoes; a tool whose
// `resolveExecution` has effects; a final allow reached via a destructured or
// bracket-notation reference such as `const {allow}=event; allow()` or
// `event['allow']()`, which the literal ".allow()" scan below does not match)
// — those remain the human checklist in docs/upstream-compat-audit.md. The
// sha256 pins below are the backstop: any byte change to a load-bearing file
// (the allow gate, the plan guard, or the restore-folding source the journal
// taint scan depends on) forces a human re-read even when a symbol scan is
// blind to the change.
//
// Run: KIMI_CODE_SOURCE_TAG_DIR=/path/to/kimi-code@<tag> bun test tests/audit/
// Skips (does not fail) when the env var is unset. When the variable names the
// top level of a kimi-code git clone, the per-release suite at the end of this
// file also reads every certified row's tag through `git show`.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";

import { KIMI_V2_RELEASES, kimiVersionsWith } from "../../runtime/kimi-releases.js";
import { PLAN_PAIR_BOOKKEEPING } from "../../runtime/native-v2-preflight.js";

const SOURCE = process.env.KIMI_CODE_SOURCE_TAG_DIR;
const suite = SOURCE !== undefined && existsSync(SOURCE) ? describe : describe.skip;

const CORE = "packages/agent-core-v2/src";
const CORE_RUNTIME = "packages/core/src";
const CLI = "apps/kimi-code/src";
const KAP = "packages/kap-server/src";
const SDK = "packages/node-sdk/src";
const KLIENT = "packages/klient/src";
const ACP = "packages/acp-server/src";

/**
 * Per-version pins for files whose exact bytes decide the construction (>= 2.8.0 floor).
 * A new version MUST add its own row after a human read of the diff; a missing row
 * fails the scan rather than silently accepting drift.
 */
const HASHES_2_8_0: Record<string, string> = {
  [`${CORE}/features/externalHooks/configSection.ts`]: "a95482d27f1a873a64d4e67fda77e844dc8dc29e424acbe03f6ffb094d832b20",
    [`${CORE}/features/externalHooks/internal/types.ts`]: "eb697379c4efdc48b0ee5ac00256d1205b85d99eefb7b19843218d35107852dc",
    [`${CORE}/agent/toolExecutor/beforeToolExecuteEvent.ts`]: "54d52bb02917cebbc97df66e92aa67ea0aab2768fe1b759c9a3f53f27571841b",
    [`${CORE}/features/plan/planService.ts`]: "bca08fffe66ed16dc75d932e39d5e069b70e099ed6fcf37544abe9a8e7cc20d2",
    [`${CORE}/state/eventDispatcherService.ts`]: "d8b74a5001eb6ec4567e674013c002ddad650f1f815f45aca2d1057962821094",
    [`${CORE}/state/state.ts`]: "e48d456b078fd387857599a8b0f7f289623d7d1614230e46b898fa4a1f719e75",
    [`${CORE}/features/plan/planOps.ts`]: "37b3d018746da238686733b66d9e9328248897859ca45f96ae28c26533564637",
    [`${CORE}/app/config/toml.ts`]: "57f3830d4fcbf48bb79f6e400efb53af3198ea64de194b381ff8545ab808e334",
    [`${CORE}/app/sessionExport/wire-scan.ts`]: "29489dabbc2a585a5cc70015a7b160f7c0a13403f102de007bbce89d1a6b5ef9",
    [`${CORE}/wire/wireService.ts`]: "04fcdaf00ce688c2cc4e9e5d243569cee3e7a2717b19a89391d0671bdac995aa",
    [`${CORE}/wire/record.ts`]: "68357abd44314ff757cd049155f35bf772f2310c2bc7dd65b793a05e417fea88",
    [`${CORE}/wire/tree/fork.ts`]: "9588d05ee09f9c5534f19f0c4be7c521b4c74c4071d489073abfa203d533a5a9",
    [`${CLI}/cli/v2/run-v2-print.ts`]: "c7e724748b238245407f6f29e6af42ac41cf84f08a90f382eee51854b1b8ccb3",
    [`${CORE}/app/sessionManager/sessionLookup.ts`]: "d4a087aa8364e1ca1b9c7b2324956d06495c8c54c880c2a767a27560c676129d",
    [`${CORE}/session/sessionActivity/sessionRunGateService.ts`]: "2ed8303ec3d042f3c613ca6e1c62d264178752609128dad710102e54ae523a01",
    [`${SDK}/sdk-rpc-client-v2.ts`]: "0e837e1ccf87f578f4018208b1a5ab1380065c3d68ffb0dbf1f45a48f90552e6",
    [`${CORE}/app/sessionManager/sessionManagerService.ts`]: "9f7b0909c592767c5affd66349d953379758a27e78be9e610fcd7ae020b3f4b6",
    [`${CORE}/workspace/sessionLifecycle/sessionLifecycleService.ts`]: "26aeced07e2a632f1ed9fe1f5b17e5755806084ce3756b841dc7fd4fd1ed8dec",
    [`${CORE}/session/agentLifecycle/agentLifecycleService.ts`]: "b69296cbf00b30993e45c8450f215696e7587a0c88a9b19e837a9cb4879ba3b5",
    [`${CORE}/agent/environmentBinding/environmentBindingService.ts`]: "6fb825ba3b5f38511bc90ce4a3adbfd2f0dd211b46f80490ff4b35deba69ee9b",
    [`${CORE}/agent/environmentBinding/environmentBindingOps.ts`]: "2f65bebb17455c435603520f73089bfdf239864742df86124e3bd8acf2aa5269",
    [`${CORE}/app/config/configService.ts`]: "afa300f75bb7f5be6636bc95686390e5554af36d600b5c77313027c6d2470b7b",
    [`${CORE}/workspace/workspaceTrust/configSection.ts`]: "e10c5e96f0211e3936d03f68ee3695c8573ceb1398aed4e0bb4a3782f500d758",
    [`${CORE}/workspace/workspaceTrust/workspaceTrustStore.ts`]: "ff59ccb811c48fe3e0535becc9a68ad8921962ca5be8ac4e8a02762690fea164",
    [`${CORE}/workspace/workspaceMcpConfig/workspaceMcpConfigService.ts`]: "d1b5324ac1c7242f14c9428fe22809f92a275111610c47684c321dffed82ba8f",
    [`${CORE}/features/externalHooks/agent/agentExternalHooksService.ts`]: "2847e3f3f75247e71bc0fd9139a28a34f7dfca8d9d0cbff87df8d395b3c64222",
    [`${CORE}/agent/tools/os/bash/bashTool.ts`]: "833de1b6a83e39ede4c7973815bf493bcc2a26ccea09bb0df61d0c80fe7b996f",
    [`${CORE}/remote/client/remoteEnvironmentProvider.ts`]: "0260b35b201e632f4e742694f962ee414bd7bbac16eb9193e08540b8e8ad26f9",
    [`${CLI}/cli/prompt-render.ts`]: "ddfc890858766e43d635a37268d6131baf3f82fbab8bd06bd5e16e3d3397265d",
    [`${CLI}/cli/goal-prompt.ts`]: "4db3c76ccdca5bf68bbb34cd083a7ff8bc0ce0363c2630bd0daef4895fd5a801",
    [`${CLI}/cli/headless-exit.ts`]: "d6a77ec31627583ab7acec016fa66070524b72b0a4730d81b7d5ec5f46cfec5c",
    [`${KAP}/protocol/ws-agent.ts`]: "0fda7f2f53f5cf73ba1b8c9fe93573bd1ba926c23c8bc4e194f6d051ae29682e",
    [`${KAP}/transport/ws/v1/agentState.ts`]: "46d265a6ed2baa50c34beccb24255e3185d5b3630b518e8302aa47cedf66a05a",
    [`${KAP}/transport/ws/bearerProtocol.ts`]: "c9ee2315b3872bcc86a1a50ba965cfa43700754b6421873fd9771067c5eb8ec2",
    [`${KAP}/transport/ws/v1/wsConnectionV1.ts`]: "8eed7a6e80a616c1f52599fcce3127e6c43fee2c12b862e3b50df9d05eeb3783",
    [`${KAP}/transport/ws/v1/sessionAgentFeed.ts`]: "bdceb5d5e0481a897f8a096c73e356927b85e8b7723521a4bb33f4d46801bd69",
    [`${KAP}/transport/ws/v1/sessionEventBroadcaster.ts`]: "0765abb76c9f02274b5d9868ec52461daac0434c7b6b97a19f21b42535724b35",
    [`${KAP}/routes/environment.ts`]: "c5e3a48fea50ab98e85b5d5d052e1a2e8e52063d5c843996f0cf5c971ae75f4d",
    [`${KAP}/routes/sessions.ts`]: "40f2640cfb434111597c2aa5129e47ba994f59aa07dbb5fc3913a22156dfad3f",
    [`${KAP}/start.ts`]: "789ac2191601f4a0def5cb8ded6a0000c7a9b7a7529548a32f5be07c540d1d30",
    [`${CORE}/agent/toolExecutor/legacyHooks.ts`]: "e900c7bb1028dab051bfa94f7e5b3c5f60b5049f4d490a2b7e2bad8b75622c0f",
    [`${CORE}/agent/toolExecutor/toolExecutorService.ts`]: "eaf092c3fd053df510b126097bbeffc8901fdbe3a14404acecd23b0fa2adca5f",
    [`${CORE}/agent/toolExecutor/toolExecutor.ts`]: "efb780931c8a690927279dfdd4c4b236709084f1a7f81cd5e6036df721936543",
    [`${CORE}/agent/permissionGate/permissionGateService.ts`]: "e54b9f3c60e16542af71b52211b8eb37eb05a05fdbcae335296075400af34f13",
    [`${CORE}/tool/executor/tool-executor.ts`]: "f4920ab7e585d545525291dab916a16f595ca4b64695f4dc18db7c9d0f29ac94",
    [`${CORE}/tool/executor/legacy-adapter.ts`]: "f0c6044ae8bc8d001e359aead0f0483a9620603e9aa8eec7e6cb670c38f749ca",
    [`${CORE}/features/externalHooks/externalHooksFeature.ts`]: "658b6655cd2484d0001240e3ddbf9bc7c740f94d9ff93cbe83ce472a12188fc1",
    [`${CORE}/wire/human.ts`]: "13bebbc0dfd6774a12a6573d53e4b0df5533db40a44e987020da4b8bbe1c193d",
    [`${CORE}/agent/shellCommand/shellCommandService.ts`]: "412b926a7df371c613b5006423d5b6d0062bb9052f0d34fbe7a26663d9e68006",
    [`${CORE}/features/swarm/agent/swarmService.ts`]: "39e7b76f2ee237d1f55ebc32ea84dee7b7d851d9370c6d4a971732869475ef39",
    [`${CORE}/features/swarm/session/agentRunBatch.ts`]: "6fc11370e81cb68ca1ae6dd89406790127dc3d2631d524bc0f3db908e050e5e4",
    [`${CORE}/features/swarm/session/sessionSwarmService.ts`]: "c2fd0e5a363918ab66f660e4b7b68120f62274dc3e1c6f751e50f6720359c547",
    [`${CORE}/features/swarm/session/swarmMemberTask.ts`]: "0d3dc139b4b3046b6aa924de1ef97a7342a0fef7f7e9680aa1c590b16186b7a4",
    [`${CORE}/agent/task/taskService.ts`]: "84f9c0c2c58903b0e35d80b6e9c8c4f245838fbed23937cdc6afbc58b50ff87e",
    [`${CORE}/agent/tools/task/task-stop/taskStopTool.ts`]: "2b0ea33daa6c7ebb28ecf756332ab2852351a69a7f9d862c37bd571e5f56b039",
    [`${CORE}/session/subagent/subagentService.ts`]: "5f2dac3f6818892bc254f1464dc462bd01bc1e6aec0fc40a11c05ed00b395502",
    [`${CORE}/features/swarm/tools/agent-swarm/agentSwarmTool.ts`]: "9353c5e958f62e7c0ede4bc635b179bda2ed201790fbbf69a16537a935587514",
    [`${CORE}/features/swarm/swarmOps.ts`]: "d7fbf7172ceb102398caaf34293c6c0851efc171d66ffb4a9201807b4d72c15a",
    [`${CORE}/agent/loop/journal.ts`]: "e1c351c9458f1a2e2aa2241d8b47ce3cc1c3673b81c64e70a9db12c14e0df132",
    [`${CORE}/agent/loop/turnOps.ts`]: "f45a1e8e41a2d8374015468fe22bb642d47c97d26ffdbd022aac216c66a919cd",
    [`${CORE}/agent/loop/loopService.ts`]: "5b4ba72ce809711e84b4b05ce3ae1020ec611bbe02c7dfbe321b32bf4f9fc050",
    [`${CORE}/agent/loop/turnProjection.ts`]: "fa4cad103b41fda7b3912e4414e216d71485706055999df3a7ca13f03e82f150",
    [`${CORE}/agent/contextMemory/loopEventFold.ts`]: "bbc2075e28049e68ee9c2cae1c2238c5d7fee91c067afb829380306447a276d4",
    [`${CORE}/session/subagent/mirrorAgentRun.ts`]: "c02c80ed75d961ce9c9f49ca12393bfd0698c9b9fceb69b9970dce439d03e5cb",
    [`${CORE}/_base/di/cascadeEngine.ts`]: "ceb727b65f6a60e1644789b30048e5bb0436270cf01b9924f8985f8a7ac78c21",
    [`${CORE}/_base/di/scope.ts`]: "62118f732d5b27cf784a801b8cc46d51a202d2e690d5cc16003774d62d50b6ff",
    [`${CORE}/features/feature.ts`]: "e0b281a039200524bd289401be1d937d0709dc1951f4352cd130e89656a3451b",
    [`${CORE}/workspace/workspaceDirs/workspaceDirsService.ts`]: "8b93555ab2d73cf12fd7e717ba935017a1add233fb0af10f288d6a731a0b6fa6",
    [`${CORE}/session/workspaceContext/workspaceRoots.ts`]: "8b1d6bfdb3da68afad5b00c9e869270996b32128148027692e446dbbc53e2487",
    [`${CORE}/workspace/workspaceTrust/workspaceTrustService.ts`]: "29c7756014c7f0ad94a640d2183b60bb6e91f36632d634af1284871b08973dc6",
    [`${CORE}/app/sessionIndex/sessionIndexSource.ts`]: "e3659f557668cf798c424e1c4a1c846abf98fe84f0750ee6b313b5baac774055",
    [`${CORE}/workspace/workspaceInstance/workspaceInstanceManagerService.ts`]: "b3df3ca89f671efa6d6f755015a824128f6200937aaf17494de662430771bcb2",
    [`${CORE}/agent/loop/profileAdapter.ts`]: "66440bf899aa19e4a499235cae55f70ea4813061365ddec2b184e0ba4457cd2a",
    [`${CORE}/features/btw/btwService.ts`]: "ba5bdc6cfb2023b998ec04e9d05229d22e978b7483b5bc9a3d8e8448ca2b6d7f",
    [`${CORE}/features/goal/goalService.ts`]: "2f7099b1e7f0320adc193266e5c2fc8dd87716d76574da31411b70e17bf486c9",
    [`${CORE}/features/tower/towerService.ts`]: "2d2d041ecd66c2d204b3a36030e3c8c04870c9ce6fdf561da528c0dc38b12337",
    [`${CORE}/agent/toolDedupe/toolDedupeService.ts`]: "4d47d0d798946652571fc6f653a235ba0de6cb3088a37878eb37e6ad9a33cb98",
    [`${CORE}/agent/toolPolicy/toolPolicyService.ts`]: "364fadd926c88eebccebf7277daae3284bc58b5b78c1cdce4b8d0d2e2682948d",
    [`${CORE}/agent/toolSelect/toolSelectService.ts`]: "86fae31764e5ef88d055b22c84ba9a08c68ca20eb885d8126599839213c72595",
    [`${CORE}/agent/mcp/mcpService.ts`]: "2eeff269aa8f25f35fd32803f661e425d82e6e276de191fae8de89211f222c28",
    [`${CORE}/features/fileHistory/fileHistoryService.ts`]: "59685167b17932f3d1f28a4a5c25af0fa71ab8c92a55f03f6a08b35aedfdeabc",
    [`${CORE}/agent/agentsMdReminder/agentsMdReminderService.ts`]: "c7c3ebc1d19372d664f24635dc65337374d7b4b3f410636920065db2ae4e81db",
    [`${CORE}/features/plan/planFeature.ts`]: "5f225e09c7d2997d35137f33fba9425bfd9c25c0cd2d4f6666a6d9a256fe3e73",
    [`${CORE}/agent/tools/os/write/write.ts`]: "2e68559fcc0cb191ab41145fa84ab83bad8f87a5d8c9d81604e3144e7ce10167",
    [`${CORE}/agent/tools/edit/edit.ts`]: "7041e1d31bbe766e3e00c7f86ade466d1887c575770b51a2022f196df1095eae",
    [`${CORE}/agent/tools/os/bash/bash.ts`]: "16b1de61b520b5a6670c81c6b1d657f7e9ed124acf695e7225322f1dafe39cef",
    [`${KAP}/protocol/ws-control.ts`]: "91cabbf7af237eb11437d6884ca9bb94d8a736e95afbf744cd14b46442eb2cc4",
    [`${KAP}/routes/sessionAgentConfig.ts`]: "6f9c15167ef1696d8726da70b01786fc0040eb0a098689ae1edfbd68c77e99e7",
    [`${CORE}/features/swarm/tools/agent-swarm/agent-swarm.ts`]: "49148cbd55ccfc9218a86f8ed00d66ca2e1da7e75bd6328150bba527c4b652b8",
    [`${CORE}/features/swarm/configSection.ts`]: "fb08489d5d56b17af20fdbd11676cf9a37127519d33e769649dd35c10164e7c3",
    [`${CORE}/features/swarm/swarmFeature.ts`]: "a28426dfd4a2f53fb66e6e00d4e8d6e4a1dd30f37d694bbaff65664c9dab2fd7",
    [`${CORE}/session/subagent/runAgentTurn.ts`]: "2e9769aa29c080a9513d8996ef68888607ade1779bab6d5357e4a6b0346265cb",
    [`${CORE}/session/subagent/spawn.ts`]: "2d826b33e4ddcdf9f2fb2bd839b0ad30889f1448f10b290f39ff4a6ac5256bf9",
    [`${CORE}/session/agentLifecycle/subagentMetadata.ts`]: "75996d22d8d1ec954d59cdc67c95e4ad25ec8685a1e14afaa4529ce3b297f7c4",
    [`${CORE}/session/agentLifecycle/profile/profiles.ts`]: "ca88c1c4034e2e06a5ba9cc2b99e20cba28d7bb29a135a98d60885caaa3c4ba3",
    [`${CORE}/agent/toolExecutor/toolScheduler.ts`]: "6112511b45092a3d63150395166b5610337732a24420cb0f9598d65f8ec667ab",
    [`${CORE}/agent/task/printDefaults.ts`]: "cd96a9ef7b5c44c7b15d197ef73ffced96718ba4306c93cfd17687a62f1d2925",
    [`${CORE}/_base/utils/timer.ts`]: "840147aa36f6c1cdd7bb8a3e479342dfeca2f3a88a885ccb6c0fb3cea7ff9b9a",
    [`${CORE}/_base/utils/abort.ts`]: "e8acf6b9bd0fadddfda105a64a2c5ad1cfb1b735b3dfb15736487e4a43db8991",
    [`${CORE}/features/externalHooks/session/sessionExternalHooksService.ts`]: "201925b50a1a49b104e79a3b6db75de4f527fd2e84c80a7c1df6785506f7b7ab",
    [`${CORE}/features/externalHooks/app/externalHooksRunnerService.ts`]: "63ebf53f2e312ca5984b50bcbaf360d3114221d2fd1c1bd44579df1f69271444",
    [`${CORE}/agent/task/taskOutput.ts`]: "bf03ba076185fb141383f940f7b83ab5e9b26702bae8f3c0333561e3062425a2",
    [`${CORE}/agent/task/configSection.ts`]: "ee84882f5d3fbf0887c6967ea060f2eec31b050aa2c9e1fa8aee752c30906d87",
    [`${CORE}/session/sessionToolPolicy/sessionToolPolicyService.ts`]: "0fd170d82e6bfe8a1e4111886f5ccf1e7ed0532bf0dcbaf6dc911f2993ccce8e",
    [`${CORE}/agent/toolPolicy/evaluate.ts`]: "087c8c39b94ffbc6dfad59a45bac792d8ddbdbfbd8898788644f97062a1f3901",
    [`${CORE}/persistence/backends/node-fs/atomicDocumentStore.ts`]: "2a738b0d4e6e806150d1c2e91b579c035f88ad4fd4aaf571c5e6637a07ef19fa",
    [`${CORE}/persistence/backends/node-fs/fileStorageService.ts`]: "1ce85627f50b58de3fc7d8b0b029bdab9d773eeea96eb8753135078b3b9d0b9e",
    [`${CORE}/session/sessionContext/sessionContext.ts`]: "d64fa89b478cfedfbab5f2f566180415ad972f2e71b25bb55d2fcb684a284b1d",
    [`${CORE}/workspace/sessionLifecycle/internal/addressing.ts`]: "9118987642f8749dc6cce9c1cd130212e807b31dc434059f60578d75725273eb",
    [`${CORE}/features/tower/tools/spawn/spawnTool.ts`]: "fdd1c37384683444bdd7f9b9595265578429061ce1ad1b346382b8bb800c60fc",
    [`${CORE}/agent/tools/ask-user-question/askUserQuestionTool.ts`]: "b6f18610da05b24270a096c7c7ee9305a22c4f6d0974c6078c717a65c626cfda",
    [`${CORE}/agent/tools/agent/agentTool.ts`]: "8200b20096a62222f1ccd0f7ab8a89cdfa7c1c0b3fde8cade31b1bf57c20a3b4",
    [`${CORE_RUNTIME}/tool/tool-executor.ts`]: "320afa56cad79d80e1e2bef4b957e3033b6bfdb3eb141f267bdf948bf79a8c84",
    [`${CORE_RUNTIME}/loop/loop-actor.ts`]: "883a154b1fe3af41ecead4697b5bd465a27aa9c4d9bf07bd44a7611cfeccbf1a",
    [`${CLI}/cli/sub/web/run.ts`]: "04b05b28ac88652779aee73f9e61bd959f5b7c3db1a326d12f09c5d0b66699a8",
    [`${KAP}/routes/meta.ts`]: "152519f2e01799e8f672f5e8c734f88a47afa4917b202a6495eaa211d63de402",
    [`${KAP}/protocol/rest-meta.ts`]: "18516d8a5268747a058f37f7f1e71be47c4eeaa7447b3485909c64ece13a0143",
    [`${KAP}/routes/registerApiV1Routes.ts`]: "cf6bf3db62956b5b21acee22c65e20c21fad8b7d9c17c4fbb2e531dac11ed0bd",
    [`${KAP}/index.ts`]: "ac37b26fdec8937f8b9d8ccf0cd449e1ab0c080cce75633c6eef2c88bac25a5b",
    [`${CORE_RUNTIME}/tool/types.ts`]: "adaabc997192bd0d6139b86ee1c3a56245059eaf70233c65093e34b751fbc5fd",
    [`${CORE_RUNTIME}/tool/args.ts`]: "99360f02a783e65425f668dc3f8bd050fd36a2479a9945a9880d20c1ab905a83",
    [`${CORE_RUNTIME}/tool/output-store.ts`]: "7dd29fcbbadd66abe78d52452b7e4b0ebeb90a6554003f91f1e5480d555d0987",
    [`${CORE_RUNTIME}/tool/validate.ts`]: "5fc3d7906972395ab086425158ac9f691444deaac71a852f038ee31bbbcb1db1",
    [`${CORE_RUNTIME}/loop/create-loop.ts`]: "6d8e4bf9a4fbe30de0d6a75da2c245c53c9a8ae33082afe06fb1d825f41ebb45",
    [`${CORE_RUNTIME}/loop/contract/emitted.ts`]: "9b4c255a31421ed37723ec995214e3952fd2142919c40593774710c15edd2ded",
    [`${CORE_RUNTIME}/llm/policy/policy.ts`]: "77f2dbe6f4cb64fefb4ff16df26f404bb8244c5959c743ee16e2bbe832b1ec09",
    [`${CORE_RUNTIME}/llm/policy/retry.ts`]: "8804d648c0f6b9208d4f3673a35d3c7456152a9d44bb3f1424b2fd1bc9adc864",
    [`${CORE_RUNTIME}/llm/policy/settle.ts`]: "308013b78708641c03ecb854578a62426b44f255d39f124b61f3314b85db63c7",
    [`${CORE_RUNTIME}/llm/policy/recovery.ts`]: "a622a10733b536d4215eac34e52973153038fc508a2e1a39b4682ecf7107ff4f",
    [`${CORE_RUNTIME}/llm/policy/credentials.ts`]: "6a173360e94ce46a99f5714b11e15839000809adc4f0b8f4cb9261aa32832bf6",
    [`${CORE}/llm-adapter/contract/errors.ts`]: "87f74f5c5d749b83971c6777763d63dbf06cc3b43b653cfa46fd66f3e746946b",
    [`${CORE_RUNTIME}/llm/response.ts`]: "df1b9a89183d3f87b13e62fa3bdd656c962c34bb8ac374205fb799e6256d5e5c",
    [`${CORE_RUNTIME}/llm/protocol/errors.ts`]: "f808584bebf6d3089752ad58193fb609dad67b3e63dbb19e08b58d228faec505",
    [`${CORE_RUNTIME}/llm/protocol/rules/status.ts`]: "be47fb08fa85a6304ff934d1d9828594b5607f47caff8b4f110028f8dd081629",
    [`${CORE_RUNTIME}/llm/requester.ts`]: "f10ad24cf1dccc7eb04b6bf71e352989207028629f187673f1f3ba333d626387",
    [`${CORE_RUNTIME}/utils/abort.ts`]: "d1b20d9f1862842419f49c5b259bbc6276ab13ad17a7d7abfc52eeffd56ac911",
    [`${CORE}/features/promptPrediction/promptPrediction.ts`]: "6ceab958a79db24510fcc1f679753075a8230fbbbee2fb835256bf0db5fc5d77",
    [`${CORE}/features/promptPrediction/promptPredictionService.ts`]: "9f921424589ab5a592be39fed84805c2f9a7147788e26090a3798acdd029301b",
    [`${SDK}/v2/resume-replay.ts`]: "9755904af88307320013d230fb2f8860cc7d563693a42d1ed1746b369175e31f",
    [`${KAP}/transport/ws/v1/taskRequests.ts`]: "ba3b5fff35fc372e94a69f3388616c8f1166823121256e096c980433219dda78",
    [`${KAP}/transport/ws/v1/registerWsV1.ts`]: "f0b2e5b8b65bc70c9ee7df92eb993ab1f64e36d717128083849fca772cfea50b",
    [`${CLI}/cli/commands.ts`]: "c801169c5a33b239f82795f9a5774090a79af0ca945225d7192da8f255a49873",
    [`${CLI}/cli/options.ts`]: "ffcbde708de9c4730814f246450f2bd211a51641e83b8dcd4d5b8e4d8f2832e2",
    [`${CLI}/cli/main.ts`]: "e0bccbe77e49768e4d85a4b5317226afc9faeecfdfbf711114b80f76ac4c8105",
    [`${CLI}/cli/update/preflight.ts`]: "5a72c0c69f846f2dfb2cd01862fb143cfe8735bbc6a681856f8bc80a00191cdb",
    [`${CLI}/cli/update/forced.ts`]: "3337af0706eb882fd56b2245a7491375c67ffe357f0730b8bd99e9d033377749",
    [`${CLI}/cli/update/native-swap.ts`]: "8aa424c2d9ae19e506c85bc917ff1deebf35562186152d57dddee4b8e1453739",
    [`${KLIENT}/core/facade/agent.ts`]: "9a37f478ffa5ca249f0fa532dcb70481eddbafea04972122ebbb6b098b4020e3",
    [`${ACP}/session.ts`]: "df7805cf2b677f6990720dcc0d3e072589c071db132777076dc90ee8c7f4fddc",
    [`${CORE}/agent/loop/requestMetadata.ts`]: "25bd79507736a66045859350268b3114020fc13bf5fabcb53f972c91b8e49bbb",
    [`${CORE}/agent/loop/requestObservation.ts`]: "51cac2b8cfb5e4312abc820c737f966711d500b3274cfde072f4220d47433250",
    [`${CORE}/session/requestAttribution/requestAttribution.ts`]: "3a59320b98c5c1a16813c60eea605286ac812eb58079f75517e7120d5435bb48",
    [`${CORE}/session/requestAttribution/requestAttributionService.ts`]: "1f233b5ffc01c9929d5c13012ea8f14d49afd6a264ce7fd0bc606ad047802453",
    [`${KAP}/services/legacyStatus/legacyStatus.ts`]: "b369f294ee6a3a2e53f62819384c5660c51836319824c55e391cc483b23ff0e3",
    [`${KAP}/services/conversation/conversationFold.ts`]: "7c4e6a02883630c1f1b7eb70be729c1d8862b88fdc16739712bf07ad49216c30",
    [`${CORE_RUNTIME}/hook/tool-executor/registry.ts`]: "7c156995f7e90ef4c1d4a9c70a90b510da3c26d822e3fd12b1e0a25fbdebef22",
    [`${CORE_RUNTIME}/hook/registry.ts`]: "002603fe818e910ce87c40049ec256a0b66c3504a94f2b05821a9cc3e0242387",
    [`${CORE_RUNTIME}/hook/result.ts`]: "749b4c9bc71563e0fc3184787d4d2baac36e9df9944d91d4e68ac2da1a2c2e38",
    [`${CORE_RUNTIME}/hook/loop/run.ts`]: "ab1449f2f85debcef1921169217bf4b6f5a0590005b80b39dd94c130c199d7e5",
    [`${CORE_RUNTIME}/hook/loop/registry.ts`]: "bd41686e93f562ff3e38bbc3c77542ee890ef9b1691eaf5dd7cbf9bcac23c912",
    [`${CORE_RUNTIME}/loop/turn/create-turn.ts`]: "b0736f3722b0c03a9a7c9ff9ab8129d86bdd7980f319998df83b9548ba9aac76",
    [`${CORE_RUNTIME}/store/backend/node.ts`]: "645f691cedf65e5041465ed35c2903b837053afe40ce6907d20c0304a77a3d53",
    [`${CORE}/agent/permissionPolicy/permissionPolicyService.ts`]: "b16bbc3c8678eb384dd0589f7e442d8e3ad1c7ecaecdadef8b6ca2499d02f0e1",
    [`${CORE}/agent/permissionPolicy/policies/bash-read-only.ts`]: "f2a640271f33957b95bc67017dbe8264a9632fe37b1f2f451bf09ec1bc47337e",
    [`${CORE}/agent/permissionPolicy/policies/bash-read-only-specs.ts`]: "e90a859048a860f141fd509517729d24d3080130cd7148b3d7759f0f5224563a",
    [`${CORE}/features/plan/tools/exit-plan-mode/exitPlanModeTool.ts`]: "1d36cf9c8bcd8c24ab93199928740f147f6e6a959abf59afbf83f0cead38083a",
    [`${CORE}/features/tower/towerOps.ts`]: "90de8ecdee312b68bcae931f2c2528f8ae827e3cb6559b78429e04742687f28f",
    [`${CORE}/agent/mcp/mcpDiscoveryOps.ts`]: "e0ab31236276de123509579d6b1a9ad8b5bb4110c60468eb4ac72aa009d7fe6c",
    [`${CORE}/agent/mcp/mcpFailureOps.ts`]: "cc345370443fc1064407ca56fb885cc0105a1ed4843628eb237a5c655df7b4a9",
  [`${CORE}/agent/tools/task/task-wait/taskWaitTool.ts`]: "2b6c62a2fc611c6bf27f998d76d3de98f072dde83e91e1fb4ea09fd9aa42dc35",
  [`${CORE}/agent/tools/task/task-wait/task-wait.ts`]: "70a620adb3bad8da904d5e5d77e6e6ac2fa5e8f7540d1c9507a60a269c7b08e2",
};

const PINNED_HASHES: Record<string, Record<string, string>> = {
  "2.8.0": HASHES_2_8_0,
  "2.8.1": {
    ...HASHES_2_8_0,
    [`${CORE}/agent/toolSelect/toolSelectService.ts`]: "ced5e3ca3e9ef7230f69be16b55f3237d6516a9461c9f7c53a43644d630f7eb4",
  },
};

/**
 * Every durable plan-state event type at the pinned tag. The journal taint scan
 * (runtime/native-v2-preflight.ts::scanJournalLines) treats any record whose
 * decoded `type` starts with `plan_mode.` or `plan.` as taint; this list is
 * what makes that prefix test complete rather than a guess.
 */
const EXPECTED_PLAN_EVENT_TYPES = [
  "plan_mode.enter",
  "plan_mode.cancel",
  "plan_mode.exit",
  "plan.revision",
];

function abs(rel: string): string {
  return path.join(SOURCE ?? "", rel);
}

function read(rel: string): string {
  return readFileSync(abs(rel), "utf8");
}

function isProductionTs(rel: string): boolean {
  return rel.endsWith(".ts") && !rel.includes("/test/") && !rel.endsWith(".test.ts");
}

function* walk(rel: string): Generator<string> {
  const dir = abs(rel);
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const childRel = path.join(rel, entry);
    if (statSync(abs(childRel)).isDirectory()) {
      yield* walk(childRel);
    } else {
      yield childRel;
    }
  }
}

function filesContaining(roots: string[], needle: string | RegExp): string[] {
  const hits: string[] = [];
  for (const root of roots) {
    for (const rel of walk(root)) {
      if (!isProductionTs(rel)) continue;
      const contents = read(rel);
      const matched = typeof needle === "string" ? contents.includes(needle) : needle.test(contents);
      if (matched) hits.push(rel);
    }
  }
  return hits.sort();
}

function upstreamVersion(): string {
  const pkg = JSON.parse(read("apps/kimi-code/package.json")) as { version: string };
  return pkg.version;
}

function versionAtLeast(version: string, major: number, minor: number): boolean {
  const [maj = 0, min = 0] = version.split(".").map(Number);
  return maj > major || (maj === major && min >= minor);
}

function upstreamAtLeast(major: number, minor: number): boolean {
  return versionAtLeast(upstreamVersion(), major, minor);
}

suite("native-v2 tag scan (>= 2.8.0 floor): the no-plan construction holds at this source tree", () => {
  test("the tag meets the >= 2.8.0 floor, is pinned, and its load-bearing files are byte-identical", () => {
    const version = upstreamVersion();
    expect(upstreamAtLeast(2, 8), `kimi-code ${version} is below the 2.8.0 floor`).toBe(true);
    const pins = PINNED_HASHES[version];
    expect(pins, `no pinned hashes for kimi-code ${version}; audit the diff and add a row`).toBeDefined();
    for (const [rel, expected] of Object.entries(pins ?? {})) {
      const actual = createHash("sha256").update(readFileSync(abs(rel))).digest("hex");
      expect(actual, `${rel} changed since the audited ${version} bytes`).toBe(expected);
    }
  });

  test("nothing calls the emitter's final allow; plan-file allow sits behind skipPermitting", () => {
    const sites = filesContaining([CORE, CORE_RUNTIME, CLI, KAP, SDK, KLIENT, ACP], ".allow()");
    expect(sites).toEqual([]);
    expect(filesContaining([CORE, CORE_RUNTIME, CLI, KAP, SDK, KLIENT, ACP], /\ballow: true\b/)).toEqual([
      `${CORE}/agent/toolExecutor/beforeToolExecuteEvent.ts`,
    ]);
    expect(read(`${CORE}/agent/toolExecutor/beforeToolExecuteEvent.ts`)).toContain(
      "if (event.finalAllowed) return { allow: true };",
    );
  });

  test("plan service entry callers match the exact audited tool surface", () => {
    expect(filesContaining([CORE, CORE_RUNTIME, CLI, KAP, SDK, KLIENT, ACP], "new PlanModeEnter(")).toEqual([
      `${CORE}/features/plan/planService.ts`,
    ]);
    const enterCallers = filesContaining([CORE, CORE_RUNTIME, CLI, KAP, SDK, KLIENT, ACP], "IAgentPlanService").filter((rel) =>
      read(rel).includes(".enter("),
    );
    expect(enterCallers).toEqual([
      `${CORE}/workspace/sessionLifecycle/sessionLifecycleService.ts`,
      `${KAP}/routes/sessionAgentConfig.ts`,
    ]);
    expect(filesContaining([CORE], "EnterPlanMode")).toEqual([]);
  });

  test("host plan entry stays explicit and outside the print runner", () => {
    expect(read(`${SDK}/sdk-rpc-client-v2.ts`)).toContain("return agent.enterPlan()");
    expect(read(`${KLIENT}/core/facade/agent.ts`)).toContain(
      "enterPlan: () => call(scope, 'agentPlanService', 'enter', []) as Promise<void>",
    );
    expect(read(`${ACP}/session.ts`)).toContain("await this.agent.enterPlan();");
    expect(read(`${CLI}/cli/v2/run-v2-print.ts`)).not.toContain("setPlanMode(");
  });

  test("print bootstrap preserves provenance, local-selection, and host-only plan boundaries", () => {
    const runner = read(`${CLI}/cli/v2/run-v2-print.ts`);
    const marker = runner.indexOf("writeExperimentalVersion(");
    const sdk = runner.indexOf("new SDKRpcClientV2(");
    expect(marker).toBeGreaterThan(-1);
    expect(sdk).toBeGreaterThan(marker);
    expect(runner).not.toContain("setPlanMode(");
    expect(runner).toContain("environmentId: opts.environment");
    expect(runner).toContain("environmentCwd: opts.environmentCwd");
    expect(runner).toContain("permissionMode.setMode('auto')");
    expect(runner).toContain("agent.accessor.get(IAgentPermissionModeService).setMode('auto')");
    const sdkClient = read(`${SDK}/sdk-rpc-client-v2.ts`);
    expect(sdkClient).toContain("override async setPlanMode(");
    expect(sdkClient).toContain("return agent.enterPlan()");
  });

  test("environment and workspace-trust dependencies are explicitly reviewed", () => {
    expect(read(`${CORE}/app/sessionManager/sessionManagerService.ts`)).toContain(
      "options.environmentId === LOCAL_ENVIRONMENT_ID",
    );
    expect(read(`${CORE}/workspace/sessionLifecycle/sessionLifecycleService.ts`)).toContain(
      "environment.environmentId === LOCAL_ENVIRONMENT_ID",
    );
    expect(read(`${CORE}/agent/environmentBinding/environmentBindingOps.ts`)).toContain(
      "static override readonly type = 'environment.set_binding'",
    );
    const trust = read(`${CORE}/workspace/workspaceTrust/configSection.ts`);
    expect(trust).toContain("requireTrust: z.boolean().optional()");
    expect(trust).toContain("requireTrust: true");
    expect(read(`${CORE}/workspace/workspaceTrust/workspaceTrustStore.ts`)).toContain(
      "if (!this.trustGateEnabled()) return true",
    );
    expect(read(`${CORE}/workspace/workspaceMcpConfig/workspaceMcpConfigService.ts`)).toContain(
      "includeProject: trusted",
    );
  });

  test("WebSocket state proof remains authenticated and bound to the live main agent", () => {
    const schema = read(`${KAP}/protocol/ws-agent.ts`);
    for (const field of ["session_id", "agent_id", "model", "permission_mode", "plan_mode", "swarm_mode", "tower_mode"]) {
      expect(schema).toContain(field);
    }
    expect(read(`${KAP}/transport/ws/bearerProtocol.ts`)).toContain("kimi-code.bearer.");
    expect(read(`${KAP}/transport/ws/v1/agentState.ts`)).toContain("readAgentState");
    const broadcaster = read(`${KAP}/transport/ws/v1/sessionEventBroadcaster.ts`);
    const control = read(`${KAP}/protocol/ws-control.ts`);
    expect(control).toContain("type: z.literal('subscribe')");
    expect(control).toContain("type: z.literal('response')");
    expect(control).toContain("request_id: z.string().min(1)");
    expect(control).toContain("session_id: z.string().min(1)");
    expect(control).toContain("agent_ids: z.array(z.string().min(1)).min(1).optional()");
    expect(control).not.toContain("server_hello");
    const connection = read(`${KAP}/transport/ws/v1/wsConnectionV1.ts`);
    expect(connection).toContain("agentIds ?? [MAIN_AGENT_ID]");
    expect(connection).toContain("this.respond(requestId, ErrorCode.SUCCESS)");
    expect(connection).not.toContain("client_hello");
    const accepted = broadcaster.indexOf("accepted?.();");
    const snapshot = broadcaster.indexOf("this.sendAgentLists(state, target, added);");
    expect(accepted).toBeGreaterThan(-1);
    expect(snapshot).toBeGreaterThan(accepted);
    expect(read(`${KAP}/routes/environment.ts`)).toContain("path: '/sessions/{session_id}/environment'");
    const start = read(`${KAP}/start.ts`);
    expect(start).toContain("extractWsBearerToken(req.headers['sec-websocket-protocol'])");
    expect(start).toContain("ok = await validateCredential(candidate)");
    expect(start.indexOf("ok = await validateCredential(candidate)")).toBeLessThan(
      start.indexOf("wss.handleUpgrade(req, socket, head"),
    );
  });

  test("JSON bootstrap and meta preserve authenticated direct-subscription discovery", () => {
    const web = read(`${CLI}/cli/sub/web/run.ts`);
    expect(web).toContain("randomBytes(32).toString('base64url')");
    expect(web).toContain("timingSafeEqual(actual, expected)");
    expect(web).toContain("'--json cannot be combined with --dangerous-bypass-auth.'");
    expect(web).toContain("'--json cannot be combined with --socket.'");
    expect(web).toContain("authTokenService: createEphemeralAuthTokenService(ephemeralToken!)");
    expect(web).toContain("skipInstanceRegistry: true");
    expect(web).toContain("logToStderr: true");
    expect(web).toContain("origin: normalizedOrigin");
    expect(web).toContain("ws_url: wsUrl");
    expect(web).toContain("kimi_agent_protocol_version: KIMI_AGENT_PROTOCOL_VERSION");
    expect(web).toContain("authTokenService: options.authTokenService");
    expect(web).toContain("disableAuth: options.dangerousBypassAuth");
    const meta = read(`${KAP}/routes/meta.ts`);
    expect(meta).toContain("KIMI_AGENT_PROTOCOL_VERSION = '1.0.0'");
    expect(meta).toContain("kimi_agent_protocol_version: KIMI_AGENT_PROTOCOL_VERSION");
    expect(meta).toContain("websocket: true as const");
    expect(meta).toContain("interactions_list: true as const");
    expect(meta).toContain("session_wait: true as const");
    expect(meta).toContain("dangerous_bypass_auth: opts.dangerousBypassAuth");
    const schema = read(`${KAP}/protocol/rest-meta.ts`);
    expect(schema).toContain("kimi_agent_protocol_version: z.string().min(1)");
    expect(schema).toContain("product: z.string().min(1).optional()");
    expect(schema).toContain("interactions_list: z.literal(true)");
    expect(schema).toContain("session_wait: z.literal(true)");
    const routes = read(`${KAP}/routes/registerApiV1Routes.ts`);
    expect(routes).toContain("product: opts.hostIdentity.productName");
    expect(routes).toContain("serverId: opts.serverId ?? ulid()");
    expect(read(`${KAP}/index.ts`)).toContain("export { KIMI_AGENT_PROTOCOL_VERSION } from './routes/meta';");
    const start = read(`${KAP}/start.ts`);
    expect(start).toContain("const disableAuth = opts.disableAuth === true || opts.socketPath !== undefined;");
    expect(start).toContain("if (!disableAuth) {");
    expect(start.indexOf("createAuthHook(authTokenService")).toBeLessThan(
      start.indexOf("await registerApiV1Routes("),
    );
  });

  test("default_plan_mode is a plain optional boolean with default false and no env binding", () => {
    const section = read(`${CORE}/features/plan/configSection.ts`);
    expect(section).toContain("z.boolean().optional()");
    expect(section).toContain("defaultValue: false");
    expect(section).not.toMatch(/\benv\s*:/);
    expect(section).toContain("DEFAULT_PLAN_MODE_SECTION = 'defaultPlanMode'");
    const toml = read(`${CORE}/app/config/toml.ts`);
    expect(toml).toContain("return str.replaceAll(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());");
    expect(toml).toContain("const domain = snakeToCamel(key);");
    const flag = read(`${CORE}/app/flag/flag.ts`);
    expect(flag).toContain("isPlainObject(rawSnake) ? cloneRecord(rawSnake) : rawSnake");
    expect(flag).toContain("fromToml: experimentalFromToml");
    expect(existsSync(abs(`${CORE}/session/subagent/flag.ts`))).toBe(false);
    expect(filesContaining([CORE, CORE_RUNTIME, CLI, KAP, SDK, KLIENT, ACP], /subagent_fork|SUBAGENT_FORK/)).toEqual([]);
    expect(read(`${CORE}/features/tower/tower.ts`)).toContain("TOWER_FLAG_ID = 'tower'");
  });

  test("print mode still rejects --plan and intercepts only /goal", () => {
    expect(read(`${CLI}/cli/options.ts`)).toContain("Cannot combine --prompt with --plan.");
    const runner = read(`${CLI}/cli/v2/run-v2-print.ts`);
    expect(runner).toContain("parseHeadlessGoalCreate(");
    expect(runner).not.toContain("dispatchInput(");
    expect(runner).not.toContain("'/plan'");
    expect(runner).toContain("plan.cancel();");
    expect(runner).toContain("await notePlanMode(agent, opts.session);");
    expect(runner).toContain("default_plan_mode is not applied in print mode");
  });

  test("print and update boundaries remain local, noninteractive, and goal-scoped", () => {
    const options = read(`${CLI}/cli/options.ts`);
    for (const flag of ["--yolo", "--auto", "--plan"]) {
      expect(options).toContain(`Cannot combine --prompt with ${flag}.`);
    }
    expect(options).toContain("Cannot combine --environment with --session/--continue:");
    const runner = read(`${CLI}/cli/v2/run-v2-print.ts`);
    expect(runner).toContain("nonInteractive: true");
    expect(runner).not.toMatch(/promptPrediction|predictNextPrompt/);
    const prediction = read(`${CORE}/features/promptPrediction/promptPredictionService.ts`);
    expect(prediction).toContain("type: 'operation'");
    expect(prediction).toContain("requestKind: 'prompt_prediction'");
    expect(prediction).toContain("if (plan !== null || !this.stillCurrent(active, scope, contextSnapshot))");
    const goal = read(`${CLI}/cli/goal-prompt.ts`);
    expect(goal).toContain("complete: 0");
    expect(goal).toContain("blocked: 3");
    expect(goal).toContain("paused: 6");
    expect(goal).toContain("if (parsed.kind !== 'create') return undefined;");
    expect(read(`${CLI}/cli/update/preflight.ts`)).toContain("env['KIMI_CODE_NO_AUTO_UPDATE']");
    expect(read(`${CLI}/cli/update/forced.ts`)).toContain("if (!isInteractive) return 'continue';");
    const swap = read(`${CLI}/cli/update/native-swap.ts`);
    expect(swap).toContain("staged.manual !== true &&");
    expect(swap).toContain("isAutoUpdateDisabledByEnv(deps.env)");
  });

  test("every tool execution passes the reviewed before-execute emitter composition", () => {
    const callers = filesContaining([CORE], "fireBeforeExecute(");
    expect(callers).toEqual([
      `${CORE}/agent/toolExecutor/beforeToolExecuteEvent.ts`,
      `${CORE}/agent/toolExecutor/legacyHooks.ts`,
      `${CORE}/agent/toolExecutor/toolExecutorService.ts`,
    ]);
  });

  test("the before-execute subscriber population is exactly the audited set", () => {
    expect(filesContaining([CORE], "registerLegacyStarting(")).toEqual([
      `${CORE}/agent/toolExecutor/legacyHooks.ts`,
      `${CORE}/agent/toolExecutor/toolExecutor.ts`,
      `${CORE}/agent/toolExecutor/toolExecutorService.ts`,
      `${CORE}/features/btw/btwService.ts`,
      `${CORE}/features/externalHooks/agent/agentExternalHooksService.ts`,
      `${CORE}/features/goal/goalService.ts`,
      `${CORE}/features/tower/towerService.ts`,
    ]);
    expect(filesContaining([CORE], "registerHook(")).toEqual([
      `${CORE}/agent/agentsMdReminder/agentsMdReminderService.ts`,
      `${CORE}/agent/permissionGate/permissionGateService.ts`,
      `${CORE}/agent/shellCommand/shellCommandService.ts`,
      `${CORE}/agent/task/taskService.ts`,
      `${CORE}/agent/toolDedupe/toolDedupeService.ts`,
      `${CORE}/agent/toolExecutor/toolExecutor.ts`,
      `${CORE}/agent/toolExecutor/toolExecutorService.ts`,
      `${CORE}/agent/toolPolicy/toolPolicyService.ts`,
      `${CORE}/agent/toolSelect/toolSelectService.ts`,
      `${CORE}/features/externalHooks/agent/agentExternalHooksService.ts`,
      `${CORE}/features/fileHistory/fileHistoryService.ts`,
      `${CORE}/features/plan/planService.ts`,
    ]);
    expect(filesContaining([CORE], "registerToolBatchStarting(")).toEqual([
      `${CORE}/agent/loop/loop.ts`,
      `${CORE}/agent/loop/loopService.ts`,
      `${CORE}/features/swarm/agent/swarmService.ts`,
    ]);
  });

  test("generic executors are constructed only inside the managed agent composition", () => {
    expect(filesContaining([CORE, CORE_RUNTIME, CLI, KAP, SDK, KLIENT, ACP], "new ToolExecutor(")).toEqual([
      `${CORE}/agent/toolExecutor/toolExecutorService.ts`,
    ]);
    const service = read(`${CORE}/agent/toolExecutor/toolExecutorService.ts`);
    expect(service.indexOf("this.legacyStarting.fireBeforeExecute(")).toBeGreaterThan(-1);
    expect(service.indexOf("this.legacyStarting.fireBeforeExecute(")).toBeLessThan(service.indexOf("new ToolExecutor("));
    const loop = read(`${CORE_RUNTIME}/loop/loop-actor.ts`);
    expect(loop).toContain("executor.execute(");
  });

  test("the shared hook registry keeps the legacy emitter ahead of every registered starting hook", () => {
    const service = read(`${CORE}/agent/toolExecutor/toolExecutorService.ts`);
    expect(service).not.toContain("composeToolExecutorHooks(");
    orderedIndexes(service, [
      "const legacyHook: AgentToolHook = {",
      "const decision = await this.legacyStarting.fireBeforeExecute(legacyExecutionContext(context));",
      "return legacyStartingDecision(context, decision);",
      "const registry = createToolExecutorHookRegistry<LegacyToolAgentContext, LegacyToolPreparation>();",
      "for (const hook of [resetHook, legacyHook, ...hooks, internalHook]) {",
      "if (hook.starting !== undefined) registry.addToolHook({ point: 'starting', hook: hook.starting.bind(hook) });",
      "return registry.hook;",
    ], "toolExecutorService composition");
    expect(service).toContain("private readonly hooks: AgentToolHook[] = [];");
    const register = service.slice(service.indexOf("  registerHook(hook: AgentToolHook) {"));
    expect(register.slice(0, register.indexOf("\n  }\n"))).toContain("this.hooks.push(hook);");

    const chain = read(`${CORE_RUNTIME}/hook/tool-executor/registry.ts`);
    const starting = chain.slice(chain.indexOf("    async starting(items, [context], control) {"));
    orderedIndexes(starting.slice(0, starting.indexOf("    async permitting(")), [
      "for (const item of items) {",
      "const decision = await control.invoke(item, [current]) as ToolStartingDecision | void;",
      "if (decision === undefined) continue;",
      "if ('reject' in decision) return decision;",
      "if ('args' in decision) {",
      "if ('skipPermitting' in decision) {",
      "return rewritten ? { skipPermitting: true, args: current.args } : { skipPermitting: true };",
    ], "tool-executor registry starting chain");

    const registry = read(`${CORE_RUNTIME}/hook/registry.ts`);
    expect(registry).toContain("const items = [...groups.values()].flatMap(");

    const executor = read(`${CORE_RUNTIME}/tool/tool-executor.ts`);
    orderedIndexes(executor, [
      "const starting = await this.decide('starting'",
      "if (starting === undefined || !('skipPermitting' in starting))",
      "const permitting = await this.decide('permitting'",
      "await this.host.hook?.beforeExecute?.(this.decisionContext())",
      "returned = await tool.execute(toolContext)",
    ], "tool-executor phases");
    const legacy = read(`${CORE}/agent/toolExecutor/legacyHooks.ts`);
    expect(legacy).toContain("if (decision?.allow === true) return { skipPermitting: true };");
    expect(legacy).toContain("if (decision?.veto !== undefined)");
    expect(read(`${CORE}/agent/permissionGate/permissionGateService.ts`)).toContain(
      "return decision !== undefined && 'skipPermitting' in decision ? undefined : decision;",
    );
  });

  test("managed PreToolUse sits on the legacy emitter and the plan guard on registerHook", () => {
    const moved = "If either registration moves, hook-before-plan ordering becomes construction-order dependent; re-audit it.";
    const external = read(`${CORE}/features/externalHooks/agent/agentExternalHooksService.ts`);
    const tools = external.slice(external.indexOf("  private registerToolHooks(toolExecutor: IAgentToolExecutorService): void {"));
    const body = tools.slice(0, tools.indexOf("\n  }\n"));
    const legacy = body.indexOf("this._register(registerLegacyStarting(toolExecutor, async (event) => {");
    const registered = body.indexOf("this._register(toolExecutor.registerHook({");
    expect(legacy, moved).toBeGreaterThan(-1);
    expect(registered, moved).toBeGreaterThan(legacy);
    const legacyBlock = body.slice(legacy, registered);
    expect(legacyBlock, moved).toContain("const reason = await this.runPreToolUse(event);");
    expect(legacyBlock, moved).toContain("if (reason !== undefined) event.veto(denyToolExecution(reason));");
    const registeredBlock = body.slice(registered);
    expect(registeredBlock, moved).not.toContain("runPreToolUse");
    expect(registeredBlock, moved).not.toMatch(/\bstarting\s*:/);
    expect(external.split("this.runPreToolUse(").length - 1, moved).toBe(1);

    const plan = read(`${CORE}/features/plan/planService.ts`);
    expect(plan, moved).not.toContain("registerLegacyStarting(");
    const guard = plan.slice(plan.indexOf("  private registerPlanGuard(toolExecutor: IAgentToolExecutorService): IDisposable {"));
    expect(guard.slice(0, guard.indexOf("\n  }\n")), moved).toContain(
      "return toolExecutor.registerHook({\n      starting: (context) => this.guardToolExecution(context),",
    );
    const check = plan.slice(plan.indexOf("  private async guardToolExecution("));
    const gate = check.indexOf("    if (plan === null) return undefined;\n\n    if (toolName === 'Write' || toolName === 'Edit') {");
    expect(gate).toBeGreaterThan(-1);
    expect(check.indexOf("if (target !== undefined && (await this.writesOnlyPlanFile(context, target))) {")).toBeGreaterThan(gate);
  });

  test("the tower and MCP journal records the resume scan names fold as it assumes", () => {
    const towerOps = read(`${CORE}/features/tower/towerOps.ts`);
    expect(towerOps).toContain("export class TowerModeEnter extends AgentEvent2<");
    expect(towerOps).toContain("static override readonly type = 'tower_mode.enter';");
    expect(towerOps).toContain("export class TowerModeExit extends AgentEvent2<");
    expect(towerOps).toContain("static override readonly type = 'tower_mode.exit';");
    orderedIndexes(towerOps, [
      "export const towerKey = defineState('tower', () => false).replayable({",
      ".on(TowerModeEnter, (_s, e, ctx) => {",
      "return true;",
      ".on(TowerModeExit, (_s, e, ctx) => {",
      "return false;",
    ], "tower state fold");
    const roots = [CORE, CORE_RUNTIME, CLI, KAP, SDK, KLIENT, ACP];
    expect(filesContaining(roots, /\.on\(TowerMode(?:Enter|Exit)\b/)).toEqual([`${CORE}/features/tower/towerOps.ts`]);
    const dispatcher = read(`${CORE}/state/eventDispatcherService.ts`);
    orderedIndexes(dispatcher, [
      "if (cls.agentDomain) {",
      "const recordAgentId = record['agentId'];",
      "if (recordAgentId === undefined) {",
      "} else if (recordAgentId !== this.agentScope.agentId) {",
      "return { cls, event: undefined };",
    ], "agent-domain replay rule");
    orderedIndexes(read(`${CORE}/features/tower/towerService.ts`), [
      "private async reconcileForeignTower(): Promise<void> {",
      "if (this.agentCtx.agentId !== 'main') return;",
      "if (!this.agentState.get(towerKey)) return;",
    ], "main-only tower adoption");

    const durableMcp = new Map<string, string>();
    for (const rel of filesContaining(roots, /static override readonly durable = true/)) {
      for (const body of read(rel).split(/^export class /m).slice(1)) {
        const type = /static override readonly type = '([^']+)'/.exec(body)?.[1];
        if (type?.startsWith("mcp.") && /static override readonly durable = true/.test(body.split(/^\}/m)[0]!)) durableMcp.set(type, rel);
      }
    }
    const mcpFiles = [`${CORE}/agent/mcp/mcpDiscoveryOps.ts`, `${CORE}/agent/mcp/mcpFailureOps.ts`];
    expect([...durableMcp.keys()].sort()).toEqual([...PLAN_PAIR_BOOKKEEPING].sort());
    expect([...new Set(durableMcp.values())].sort()).toEqual(mcpFiles);
    const allMcpTypes = filesContaining(roots, /static override readonly type = 'mcp\./).flatMap((rel) =>
      [...read(rel).matchAll(/static override readonly type = '(mcp\.[^']+)'/g)].map((match) => match[1]!)).sort();
    expect(allMcpTypes).toEqual(["mcp.server.status", "mcp.server_failed", "mcp.server_failure_resolved", "mcp.tools_discovered"]);
    expect(filesContaining(roots, /\.on\(Mcp(?:ToolsDiscovered|ServerFailed|ServerFailureResolved)\b/)).toEqual(mcpFiles);
    expect(read(`${CORE}/agent/mcp/mcpDiscoveryOps.ts`)).toContain("export const mcpDiscoveryKey = defineState('mcp.discovery', ");
    expect(read(`${CORE}/agent/mcp/mcpFailureOps.ts`)).toContain("export const mcpFailureKey = defineState('mcp.failures', ");
  });

  test("a turn reaches tools only through the loop's batch executor, and blocked or aborted batches run nothing", () => {
    const turn = read(`${CORE_RUNTIME}/loop/turn/create-turn.ts`);
    expect(turn).not.toContain("executor");
    expect(turn.split("this.runtime.executeBatch(step.batch)").length - 1).toBe(4);
    expect(turn.split(".executeBatch(").length - 1).toBe(4);
    expect(turn).toContain("const toolCalls = outcome.type === 'done' ? outcome.message.toolCalls : [];");
    const loop = read(`${CORE_RUNTIME}/loop/loop-actor.ts`);
    expect(loop.split("this.executor.execute(").length - 1).toBe(1);
    const method = sliceBetween(loop, "  private executeToolBatch(batch: TurnToolBatch)", "\n  private abortToolBatch(");
    const blocked = sliceBetween(method, "    if (batch.blocked !== undefined) {\n      return this.transition(() => {", "\n      });\n    }\n");
    expect(blocked).toContain("const outcome = blockedToolOutcome(toolCall, blocked.cause, blocked.result);");
    expect(blocked).toContain("\n        return result;\n");
    expect(blocked).not.toContain("executor");
    orderedIndexes(method.slice(method.indexOf(blocked) + blocked.length), [
      "\n    if (batch.aborted !== undefined) return this.abortedBatchResult(batch, batch.aborted.reason);\n",
      "const handler = this.executor.execute(call.toolCall, context);",
    ], "an aborted batch returns before execution");
    const backend = read(`${CORE_RUNTIME}/store/backend/node.ts`);
    expect(backend).toContain("  pathFor(scope: string, key: string): string {\n    return join(this.baseDir, scope, key);\n  }");
    const readMethod = sliceBetween(backend, "  async read(scope: string, key: string): Promise<Uint8Array | undefined> {", "\n  async *readStream(");
    expect(readMethod).toContain("    const filePath = this.pathFor(scope, key);\n");
    expect(readMethod).toContain("        bytes = await readFile(filePath);\n");
    expect(readMethod.split("readFile(").length - 1).toBe(1);
  });

  test("goal continuation points the model at WaitFor, which only waits", () => {
    expect(read(`${CORE}/features/goal/injection/goalInjection.ts`))
      .toContain("call WaitFor to wait for them inside this turn instead of ending the turn");
    expect(read(`${CORE}/agent/tools/task/task-wait/task-wait.ts`)).toContain("export const WAIT_FOR_MAX_TIMEOUT_S = 90;");
    const tool = read(`${CORE}/agent/tools/task/task-wait/taskWaitTool.ts`);
    expect([...tool.matchAll(/\bhandler\??\.(\w+)\b/g)].map((match) => match[1]).filter((name, index, all) => all.indexOf(name) === index).sort())
      .toEqual(["snapshot", "taskId", "wait"]);
    expect([...tool.matchAll(/this\.toolExecutor\.(\w+)\(/g)].map((match) => match[1]).filter((name, index, all) => all.indexOf(name) === index).sort())
      .toEqual(["handler", "handlers"]);
  });

  test("every skipPermitting producer is a reviewed site", () => {
    const roots = [CORE, CORE_RUNTIME, CLI, KAP, SDK, KLIENT, ACP];
    const counts = Object.fromEntries(
      filesContaining(roots, "skipPermitting").map((rel) => [rel, read(rel).split("skipPermitting: true").length - 1]),
    );
    expect(counts).toEqual({
      [`${CORE}/agent/permissionGate/permissionGateService.ts`]: 0,
      [`${CORE}/agent/toolExecutor/legacyHooks.ts`]: 2,
      [`${CORE}/agent/shellCommand/shellCommandService.ts`]: 1,
      [`${CORE}/features/plan/planService.ts`]: 2,
      [`${CORE_RUNTIME}/hook/tool-executor/registry.ts`]: 2,
      [`${CORE_RUNTIME}/tool/types.ts`]: 1,
      [`${CORE_RUNTIME}/tool/tool-executor.ts`]: 0,
    });
    const shell = read(`${CORE}/agent/shellCommand/shellCommandService.ts`);
    expect(shell).toContain(
      "starting: (context) => context.context.turnId === -1 ? { skipPermitting: true } : undefined,",
    );
    expect(filesContaining(roots, "turnId: -1")).toEqual([`${CORE}/agent/shellCommand/shellCommandService.ts`]);
    expect(shell.split("turnId: -1").length - 1).toBe(1);
    expect(shell).toContain("this.toolExecutor.executor.execute(call, { origin: 'shellCommand', turnId: -1 });");
    const plan = read(`${CORE}/features/plan/planService.ts`);
    const exit = plan.slice(plan.indexOf("    if (toolName === 'ExitPlanMode') {"));
    orderedIndexes(exit, [
      "if (plan === null) return undefined;",
      "const decision = await this.review.requestApproval(legacyExecutionContext(context));",
      "return { skipPermitting: true };",
    ], "planService ExitPlanMode branch");
    expect(filesContaining(roots, "legacySkipPermitting(")).toEqual([`${CORE}/agent/toolExecutor/legacyHooks.ts`]);
    expect(filesContaining(roots, "legacyStartingDecision(")).toEqual([
      `${CORE}/agent/toolExecutor/legacyHooks.ts`,
      `${CORE}/agent/toolExecutor/toolExecutorService.ts`,
      `${CORE}/features/plan/planService.ts`,
    ]);
  });

  test("the external-hooks agent service is eager (present in every agent scope)", () => {
    const feature = read(`${CORE}/features/externalHooks/externalHooksFeature.ts`);
    expect(feature).toContain("contributeAgentService(IAgentExternalHooksService, AgentExternalHooksService)");
    expect(feature).not.toContain("OnDemand");
  });

  test("hook aggregation stays first-block-wins", () => {
    const match = read(`${CORE}/features/externalHooks/internal/matchHooks.ts`);
    expect(match).toContain("results.find((result) => result.action === 'block')");
  });

  test("tool schemas the allowlist reads keep their field names", () => {
    expect(read(`${CORE}/agent/tools/os/write/write.ts`)).toMatch(/\bpath:\s*z\b/);
    expect(read(`${CORE}/agent/tools/edit/edit.ts`)).toMatch(/\bpath:\s*z\b/);
    const bash = read(`${CORE}/agent/tools/os/bash/bash.ts`);
    expect(bash).toMatch(/\bcommand:\s*z\b/);
    expect(bash).toMatch(/\bcwd:\s*z\b/);
  });

  test("session restore folds only the wire journal (the journal taint scan's premise)", () => {
    const dispatcher = read(`${CORE}/state/eventDispatcherService.ts`);
    expect(dispatcher).toContain("this.wire.readJournal()");
    expect(dispatcher).not.toMatch(/\b(loadSnapshot|readSnapshot|readCheckpoint|restoreSnapshot)\s*\(/);
    const wireReads = [...dispatcher.matchAll(/this\.wire\.(read\w*)\(/g)].map((m) => m[1]);
    expect(new Set(wireReads).size).toBeGreaterThan(0);
    for (const method of wireReads) {
      expect(["readJournal", "readRestorable", "readRestoreChains"]).toContain(method);
    }
    expect(read(`${CORE}/wire/record.ts`)).toContain("AGENT_WIRE_RECORD_KEY = 'wire.jsonl'");
    const wireService = read(`${CORE}/wire/wireService.ts`);
    expect(wireService).toContain("for await (const { record } of this.readEntries(false))");
    const logReads = wireService.match(/this\.log\.read(?:<[^>]*>)?\(\s*\n?\s*this\.wireScope,\s*\n?\s*(\w+)/g) ?? [];
    expect(logReads.length).toBeGreaterThan(0);
    for (const call of logReads) expect(call).toContain("AGENT_WIRE_RECORD_KEY");
    if (wireService.includes("readRestorable()")) {
      const body = wireService.slice(wireService.indexOf("async *readRestorable()"));
      const end = body.indexOf("\n  }\n");
      expect(end, "readRestorable() body delimiter not found — re-read wireService.ts").toBeGreaterThan(-1);
      const restorable = body.slice(0, end);
      expect(restorable).toContain("this.readStableEntries()");
      expect(restorable).toContain("restorableChain(entries, tree)");
      const fork = read(`${CORE}/wire/tree/fork.ts`);
      expect(fork).toMatch(/export function restorableChain\(\s*entries: readonly WireLine\[\],\s*tree: WireTree,?\s*\)/);
      expect(fork).not.toMatch(/from '(node:fs|#\/persist|#\/app\/storage)/);
    }
    if (wireReads.includes("readRestoreChains")) {
      const start = wireService.indexOf("async readRestoreChains()");
      expect(start, "readRestoreChains declaration missing").toBeGreaterThan(-1);
      const body = wireService.slice(start);
      const end = body.indexOf("\n  }\n");
      expect(end, "readRestoreChains body delimiter changed").toBeGreaterThan(-1);
      const chains = body.slice(0, end);
      expect(chains).toContain("const entries = await this.readStableEntries();");
      expect(chains).toContain(
        "restorable: normalizeLegacyTurnSteerRecords(restorableChain(entries, tree).map(({ record }) => record))",
      );
      const human = read(`${CORE}/wire/human.ts`);
      expect(human).toContain("normalized.push(record);");
      expect(human).not.toMatch(/plan_mode|["'`]plan\.|planMode|PlanMode/);
      expect(chains).toContain("journal: entries.map(({ record }) => record)");
      expect(dispatcher).toContain("this.replayPass(chains.restorable, true, resolved)");
      expect(dispatcher).toContain("this.replayPass(chains.journal, false, resolved)");
    }
    expect(read(`${CORE}/state/state.ts`)).toContain("snapshotExcluded");
    expect(dispatcher).toContain("this.folded.events.get(record.type)");
  });

  test("wire migrations never rewrite a record type into the plan domain", () => {
    const migrations = [...walk(`${CORE}/wire/migration`)].filter(isProductionTs);
    expect(migrations.length).toBeGreaterThan(0);
    for (const rel of migrations) {
      expect(read(rel), `${rel} references the plan domain`).not.toMatch(/plan_mode|["'`]plan\.|planMode|PlanMode/);
    }
  });

  test("every durable plan-state event type carries a prefix the journal taint scan keys on", () => {
    const ops = read(`${CORE}/features/plan/planOps.ts`);
    const declared = [...ops.matchAll(/static override readonly type = '([^']+)'/g)].map(
      (m) => m[1],
    );
    expect(declared).toEqual(EXPECTED_PLAN_EVENT_TYPES);
    for (const type of declared) {
      expect(
        type.startsWith("plan_mode.") || type.startsWith("plan."),
        `plan event type "${type}" would not be recognised by scanJournalLines`,
      ).toBe(true);
    }
    expect(ops).toContain("defineState('plan'");
    const otherDeclarers = filesContaining(
      [CORE, CORE_RUNTIME, CLI, KAP],
      /static override readonly type = '(plan_mode|plan)\./,
    ).filter((rel) => rel !== `${CORE}/features/plan/planOps.ts`);
    expect(otherDeclarers).toEqual([]);
    expect(read(`${CORE}/agent/permissionPolicy/types.ts`)).toContain(
      "export type PermissionMode = 'manual' | 'yolo' | 'auto';",
    );
  });

  test("the session store layout the journal scan walks is unchanged", () => {
    expect(read(`${CORE}/app/bootstrap/bootstrapService.ts`)).toContain(
      "this.sessionsDir = join(options.homeDir, 'sessions');",
    );
    expect(read(`${CORE}/workspace/sessionLifecycle/sessionLifecycleService.ts`)).toContain(
      "return `session_${randomUUID()}`;",
    );
    const wireScan = read(`${CORE}/app/sessionExport/wire-scan.ts`);
    expect(wireScan).toContain("const WIRE_FILENAME = 'wire.jsonl';");
    expect(wireScan).toContain("const agentsDir = join(sessionDir, 'agents');");
  });

  test("the legacy engine selector is gone (v2-only print mode)", () => {
    expect(filesContaining([CLI, CORE], "KIMI_CODE_LEGACY_FLAG")).toEqual([]);
    expect(read(`${CLI}/cli/run-prompt.ts`)).toContain("runV2Print");
  });
});

const boundedSwarmSuite = SOURCE !== undefined && existsSync(SOURCE) && upstreamAtLeast(2, 8)
  ? describe
  : describe.skip;

boundedSwarmSuite("exact bounded-swarm source premises (>= 2.8.0)", () => {
  function section(source: string, start: string, end: string): string {
    const first = source.indexOf(start);
    const last = source.indexOf(end, first + start.length);
    expect(first, `missing audited section ${start}`).toBeGreaterThan(-1);
    expect(last, `missing end of audited section ${start}`).toBeGreaterThan(first);
    return source.slice(first, last);
  }

  test("strict input constructs exactly one foreground task per new or resumed entry", () => {
    const schema = read(`${CORE}/features/swarm/tools/agent-swarm/agent-swarm.ts`);
    expect(schema).toContain(".strict()");
    expect(schema).toMatch(/items:\s*z\s*\.array\(z\.string\(\)\.trim\(\)\.min\(1\)\)/);
    expect(schema).toMatch(/resume_agent_ids:\s*z\s*\.record\(z\.string\(\)\.trim\(\)\.min\(1\), z\.string\(\)\.trim\(\)\.min\(1\)\)/);
    expect(schema).not.toMatch(/\b(?:timeout|run_in_background)\s*:/);
    const tool = read(`${CORE}/features/swarm/tools/agent-swarm/agentSwarmTool.ts`);
    expect(tool).toContain("const totalCount = resumeCount + itemCount;");
    expect(tool).toContain("return resumeCount > 0 || itemCount >= 2;");
    const specs = section(tool, "const specs: AgentSwarmSpec[] = [];", "return specs;");
    expect(specs).toContain("for (const entry of resumeEntries)");
    expect(specs).toContain("items.forEach((item, index) =>");
    expect(specs.match(/specs\.push\(/g)).toHaveLength(2);
    expect(tool).toContain("const tasks: SessionSwarmTask<AgentSwarmSpec>[] = specs.map((spec) =>");
    expect(tool).toContain("runInBackground: false,");
    expect(tool).toContain("const results = await this.swarmService.run({");
  });

  test("recovery reuses task identity after completion and ordinary retry awaits loop settlement", () => {
    const batch = read(`${CORE}/features/swarm/session/agentRunBatch.ts`);
    expect(batch).toContain("this.states = tasks.map((task, index) =>");
    expect(batch).toContain("this.pending = [...this.states];");
    expect(batch).toContain("const completion = await handle.completion;");
    const outcome = section(batch, "private handleAttemptOutcome(", "private handleAttemptError(");
    expect(outcome.indexOf("this.releaseAttempt(attempt)")).toBeLessThan(outcome.indexOf("this.requeueRateLimited(attempt, outcome.agentId)"));
    expect(batch).toContain("state.retryAgentId = agentId;");
    expect(batch).toContain("this.pending.unshift(state);");
    expect(batch).toContain("this.launcher.retry(attempt.state.retryAgentId, runOptions)");
    const runner = read(`${CORE}/session/subagent/runAgentTurn.ts`);
    expect(runner).toContain("return awaitRunCompletion(target, loop, loop.retry(), options);");
    const quiescent = section(runner, "async function awaitQuiescent(", "async function stopChildTasks(");
    expect(quiescent).toContain("const result = await loop.settled();");
    expect(quiescent).toContain("await Promise.all(active.map((task) => tasks.wait(task.taskId)));");
    const loop = read(`${CORE}/agent/loop/loopService.ts`);
    expect(section(loop, "async retry():", "private maybeSettle()")).toContain("await this.settled();");
    expect(loop).toContain("await loop.waitForIdle();\n    await this.turns.drain();");
    const settled = section(loop, "async settled(): Promise<TurnResult | undefined> {", "continueTurn(");
    orderedIndexes(settled, [
      "await this.startPromise;",
      "if (loop === undefined) {",
      "await loop.waitForIdle();\n    await this.turns.drain();",
    ], "loopService.settled");
  });

  test("active swarm rejects parallel model batches and holds the tool lease until return", () => {
    const mode = read(`${CORE}/features/swarm/agent/swarmService.ts`);
    const guard = section(mode, "loop.registerToolBatchStarting(", "enter(trigger:");
    expect(guard).toContain("if (!this.isActive) return undefined;");
    expect(guard).toContain("(toolCall) => toolCall.name === 'AgentSwarm'");
    expect(guard).toContain("agentSwarmCount === 1 && event.toolCalls.length === 1");
    expect(guard).toContain("reason: 'agent_swarm_batch'");
    expect(read(`${CORE}/features/swarm/tools/agent-swarm/agentSwarmTool.ts`)).toContain("accesses: ToolAccesses.all(),");
    const executor = read(`${CORE}/agent/toolExecutor/toolExecutorService.ts`);
    expect(executor).toContain("const release = await batch.scheduler.lease(");
    expect(executor).toContain("context.prepared.onExecuted = () => {");
    const scheduler = read(`${CORE}/agent/toolExecutor/toolScheduler.ts`);
    expect(scheduler).toContain("return { result: new Promise<void>((resolve) => { release = resolve; }) };");
    expect(scheduler).toContain("ToolAccesses.conflict(task.accesses, candidate.accesses)");
  });

  test("fresh children have per-agent inactive swarm state and cannot enter it as a tool", () => {
    const feature = read(`${CORE}/features/swarm/swarmFeature.ts`);
    expect(feature).toContain("this.contributeAgentService(IAgentSwarmService, AgentSwarmService, {");
    expect(feature).toContain("activation: ScopeActivation.OnScopeCreated");
    const state = read(`${CORE}/features/swarm/swarmOps.ts`);
    expect(state).toContain("defineState('swarm', (): SwarmModeTrigger | null => null)");
    expect(state).toContain("if (e.trigger === 'tool') return s;");
    const mode = read(`${CORE}/features/swarm/agent/swarmService.ts`);
    expect(mode).toMatch(/if \(trigger === 'tool'\) \{\s*throw new Error2\(ErrorCodes\.VALIDATION_FAILED, 'Only the user can turn on swarm mode\.'/);
    const tool = read(`${CORE}/features/swarm/tools/agent-swarm/agentSwarmTool.ts`);
    expect(tool.match(/if \(!this\.swarmMode\.isActive\) return SWARM_MODE_OFF_RESULT;/g)).toHaveLength(2);
    const profiles = read(`${CORE}/session/agentLifecycle/profile/profiles.ts`);
    expect(section(profiles, "const CODER_TOOLS = [", "const EXPLORE_TOOLS = [")).not.toContain("'AgentSwarm'");
    expect(filesContaining([CORE, CLI, KAP, SDK], "new SwarmModeEnter(")).toEqual([
      `${CORE}/features/swarm/agent/swarmService.ts`,
    ]);
  });

  test("resume uses only idle children owned by the caller in the current session", () => {
    const service = read(`${CORE}/features/swarm/session/sessionSwarmService.ts`);
    const resume = section(service, "private async resumeAttempt(", "private async observe(");
    expect(resume).toContain("await this.requireOwnedSubagent(callerAgentId, agentId)");
    expect(resume).toContain("this.requireIdleSubagent(agentId, child);");
    const ownership = section(service, "private async requireOwnedSubagent(", "export type _AgentRunUsage");
    expect(ownership).toContain("meta === undefined || !isSubagentMeta(meta)");
    expect(ownership).toContain("subagentParentAgentId(meta) !== callerAgentId");
    expect(ownership).toContain("const meta = await this.metadata.read();");
    expect(ownership).toContain("return meta.agents?.[agentId];");
    expect(service).toContain("child.accessor.get(IAgentLoopService).snapshot().state === 'running'");
    const metadata = read(`${CORE}/session/agentLifecycle/subagentMetadata.ts`);
    expect(metadata).toContain("return meta.type === 'sub';");
    expect(metadata).toContain("firstNonEmpty(meta.labels?.['parentAgentId'], meta.parentAgentId ?? undefined)");
  });

  test("fork is removed from subagent creation; only /btw calls agentLifecycle.fork", () => {
    expect(read(`${CORE}/features/swarm/tools/agent-swarm/agent-swarm.ts`)).not.toMatch(/\bfork\b/i);
    expect(read(`${CORE}/features/swarm/tools/agent-swarm/agentSwarmTool.ts`)).not.toMatch(/\bfork\b/i);
    expect(existsSync(abs(`${CORE}/session/subagent/flag.ts`))).toBe(false);
    expect(read(`${CORE}/session/subagent/spawn.ts`)).not.toMatch(/fork/i);
    const subagents = read(`${CORE}/session/subagent/subagentService.ts`);
    expect(subagents.split("this.agentLifecycle.create(").length - 1).toBe(1);
    expect(subagents).not.toMatch(/fork/i);
    expect(filesContaining([CORE, CLI, KAP, SDK], "agentLifecycle.fork(")).toEqual([
      `${CORE}/features/btw/btwService.ts`,
    ]);
  });

  test("native timeout accepts the positive maximum timer and has no model-input override", () => {
    const config = read(`${CORE}/features/swarm/configSection.ts`);
    expect(config).toContain("export const SWARM_TIMEOUT_ENV = 'KIMI_CODE_SWARM_TIMEOUT_MS';");
    expect(config).toContain("return Number.isInteger(parsed) && parsed >= 1 ? parsed : undefined;");
    expect(config).toContain("timeoutMs: { env: SWARM_TIMEOUT_ENV, parse: parseTimeoutMsEnv }");
    const timer = read(`${CORE}/_base/utils/timer.ts`);
    expect(timer).toContain("export const MAX_TIMER_DELAY_MS = 0x7fffffff;");
    expect(timer).toContain("setTimeout(callback, Math.min(timeoutMs, MAX_TIMER_DELAY_MS))");
    const tool = read(`${CORE}/features/swarm/tools/agent-swarm/agentSwarmTool.ts`);
    expect(tool).toContain("const timeoutMs = resolveSwarmTimeoutMs(this.config);");
    expect(tool).toContain("timeout: timeoutMs,");
    const batch = read(`${CORE}/features/swarm/session/agentRunBatch.ts`);
    expect(batch).toContain("task.timeout === undefined || task.timeout <= 0");
    expect(batch).toContain("attempt.controller.abort(new Error('Subagent timed out.'))");
    const defaults = read(`${CORE}/agent/task/printDefaults.ts`);
    expect(defaults).toContain("if (!isUnset(inspected, key)) return;");
    expect(defaults).toContain("PRINT_SWARM_TIMEOUT_MS_DEFAULT = 0");
  });

  test("native cancellation still needs the plugin deadline and quiescence closure", () => {
    const batch = read(`${CORE}/features/swarm/session/agentRunBatch.ts`);
    expect(batch).toContain("this.controller.abort(this.batchSignal?.reason);");
    const abort = read(`${CORE}/_base/utils/abort.ts`);
    expect(section(abort, "export function abortable<T>(", "export function linkAbortSignal(")).toContain("reject(abortReason(signal));");
    const runner = read(`${CORE}/session/subagent/runAgentTurn.ts`);
    const completion = section(runner, "async function awaitRunCompletion(", "async function awaitQuiescent(");
    expect(completion).toContain("loop.cancel(undefined, reason);");
    expect(completion).toContain("abortCleanup ??= stopChildTasks(target, loop, reason);");
    expect(completion).toContain("lastResult = await awaitQuiescent(target, loop);");
    const stop = section(runner, "async function stopChildTasks(", "function classifyTurnResult(");
    expect(stop).toContain("loop.suppressTaskNotifications(active.map((task) => task.taskId));");
    expect(stop).toContain("await Promise.all(active.map((task) => tasks.stop(task.taskId, message)));");
    const mirror = read(`${CORE}/session/subagent/mirrorAgentRun.ts`);
    expect(mirror.indexOf("await subagents?.hooks.onWillStartAgentTask.run(")).toBeLessThan(mirror.indexOf("const result = await run.completion;"));
    const hooks = read(`${CORE}/features/externalHooks/session/sessionExternalHooksService.ts`);
    expect(hooks).toContain("subagents.hooks.onWillStartAgentTask.register('externalHooks'");
    expect(hooks).toContain("ctx.signal.throwIfAborted();");
    const external = read(`${CORE}/features/externalHooks/app/externalHooksRunnerService.ts`);
    expect(external).toContain("return this.triggerInner(event, args).catch((error: unknown): HookResult[] => {");
    expect(external).toContain("return Promise.resolve([]);");
  });

  test("detached completion can wake a finished child and must be prevented", () => {
    const loop = read(`${CORE_RUNTIME}/loop/loop-actor.ts`);
    const finish = section(loop, "private finishTurn(", "private closeRuntime(");
    expect(finish).toContain("if (slot.turnId !== turn.machine.id || slot.detached) continue;");
    expect(finish).toContain("ctrl.setState({ status: 'idle' });");
    const complete = section(loop, "private completeTool(", "private completeDetached(");
    expect(complete).toContain("if (slot.detached) {");
    expect(complete).toContain("slot.completionPending = true;");
    expect(complete).toContain("this.completeDetached(slot, settledOutcome, message);");
    const completion = section(loop, "private drainDetachedCompletions(): void {", "private notifyCompletionWaiters(");
    expect(completion).toContain("type: 'tool.async_ended'");
    expect(completion).toContain("const shouldQueue = this.shouldQueueTaskNotification?.(slot.handler.taskId) ?? true;");
    expect(completion).toContain("this.mailbox.queue([message]);");
    expect(completion).toContain("if (drained && !this.resetting) this.held = false;");
    expect(loop).toContain("return this.normal.length > 0 || this.notifyEntries.length > 0;");
    const onSchedule = section(loop, "onSchedule: (ctrl) => {", "onClose: (ctrl) =>");
    expect(onSchedule).toContain("if (ctrl.state.status !== 'idle' || this.hasPendingCompletions) return;");
    expect(onSchedule).toContain("this.schedule(ctrl);");
    const schedule = section(loop, "private canSchedule(state: LoopActorState): boolean {", "private schedule(ctrl: LoopControl): boolean {");
    expect(schedule).toContain("state.status === 'idle' &&");
    expect(schedule).toContain("!this.held &&");
    expect(schedule).toContain("!this.hasPendingCompletions &&");
    expect(schedule).toContain("(this.mailbox.hasTrigger || this.mailbox.hasReminders)");
    const scheduled = section(loop, "private schedule(ctrl: LoopControl): boolean {", "private activate(");
    expect(scheduled).toContain("const next = this.mailbox.hasTrigger ? this.mailbox.take(this.durable.nextTurnId) : undefined;");
    expect(scheduled).toContain("this.activate(ctrl, next);");
    const actor = read(`${CORE_RUNTIME}/actor/actor.ts`);
    expect(section(actor, "const runSchedule = (): void => {", "const drainCheckpoint = (): void => {")).toContain("options.onSchedule?.(ctrl);");
    expect(section(actor, "const drainCheckpoint = (): void => {", "flushingCheckpoint = false;")).toContain("runSchedule();");
    expect(read(`${CORE}/agent/loop/loopService.ts`)).toContain(
      "shouldQueueTaskNotification: (taskId) => !this.suppressedTaskNotifications.has(taskId),",
    );
    expect(filesContaining([CORE, CORE_RUNTIME, CLI, KAP, SDK], ".suppressTaskNotifications(")).toEqual([
      `${CORE}/session/subagent/runAgentTurn.ts`,
    ]);
    expect(read(`${CORE}/agent/task/taskOutput.ts`)).toContain("source: 'async-tool'");
  });

  test("native TaskStop disablement prevents explicit and timeout-triggered Bash detachment", () => {
    const bash = read(`${CORE}/agent/tools/os/bash/bashTool.ts`);
    const allowed = section(bash, "private allowBackground():", "private autoBackgroundOnTimeout():");
    expect(allowed).toContain("this.toolPolicy.isToolActive('TaskList') &&");
    expect(allowed).toContain("this.toolPolicy.isToolActive('TaskOutput') &&");
    expect(allowed).toContain("this.toolPolicy.isToolActive('TaskStop')");
    expect(bash).toContain("bashAutoBackgroundOnTimeout ?? true");
    expect(bash).toContain("if (this.allowBackground() && this.autoBackgroundOnTimeout() && !detached)");
    expect(bash).toContain("timedOut = true;\n        stopReason = 'Timed out';\n        void proc.kill('SIGTERM')");
    const validate = section(bash, "private validateRunRequest(", "private backgroundStartedResult(");
    expect(validate).toContain("if (args.run_in_background !== true) return undefined;");
    expect(validate).toContain("if (!this.allowBackground())");
    expect(read(`${CORE}/agent/tools/os/bash/bash.ts`)).toContain("export const MAX_TIMEOUT_S = 5 * 60;");
    const config = read(`${CORE}/agent/task/configSection.ts`);
    expect(section(config, "export const taskEnvBindings:", "export const stripTaskEnv")).not.toContain("bashAutoBackgroundOnTimeout");
  });

  test("cold-loaded session policy is shared by every agent and overrides profile tool allowance", () => {
    const policy = read(`${CORE}/session/sessionToolPolicy/sessionToolPolicyService.ts`);
    expect(policy).toContain("const STATE_KEY = 'state.json';");
    expect(policy).toContain("this.scope = sessionContext.scope('tool-policy');");
    expect(policy).toContain("this.ready = this.load();");
    expect(policy).toContain("const stored = await this.store.get<SessionToolPolicyState>(this.scope, STATE_KEY);");
    expect(policy).toContain("this.state = { disabledTools: [...new Set(stored.disabledTools)] };");
    expect(policy).toContain("LifecycleScope.Session,\n  ISessionToolPolicy,");
    const lifecycle = read(`${CORE}/workspace/sessionLifecycle/sessionLifecycleService.ts`);
    expect(lifecycle).toContain("await handle.accessor.get(ISessionToolPolicy).ready;");
    const agentPolicy = read(`${CORE}/agent/toolPolicy/toolPolicyService.ts`);
    expect(section(agentPolicy, "isToolActiveForProfile(", "async setSessionDisabledTools(")).toContain("sessionDisabledTools: this.sessionToolPolicy.disabledTools()");
    expect(read(`${CORE}/agent/toolPolicy/evaluate.ts`)).toContain("isToolActive({ disallowedTools: layers.sessionDisabledTools }, name, source)");
    expect(read(`${CORE}/session/sessionContext/sessionContext.ts`)).toContain("`${sessionScope}/${subKey}`");
    expect(read(`${CORE}/workspace/sessionLifecycle/internal/addressing.ts`)).toContain("return join(homeDir, sessionScopeOf(handlerScope, sessionId));");
    const store = read(`${CORE}/persistence/backends/node-fs/atomicDocumentStore.ts`);
    expect(store).toContain("JSON.parse(textDecoder.decode(bytes))");
    expect(store).toContain("await this.storage.write(scope, key, this.codec.encode(value), { atomic: true });");
    const files = read(`${CORE}/persistence/backends/node-fs/fileStorageService.ts`);
    expect(files).toContain("import { FileStorageService as CoreFileStorageService } from '@moonshot-ai/core/store/backend/node';");
    expect(files).toContain("export class FileStorageService extends CoreFileStorageService implements IFileSystemStorageService {");
    expect(files).toContain("super(baseDir, dirMode, fileMode, toStorageIoError);");
    expect(files).not.toMatch(/\b(?:pathFor|read|write)\s*\(/);
    expect(JSON.parse(read(`${CORE_RUNTIME}/../package.json`)).exports["./*"]).toEqual({ types: "./src/*.ts", default: "./src/*.ts" });
    const backend = read(`${CORE_RUNTIME}/store/backend/node.ts`);
    expect(backend).toContain("pathFor(scope: string, key: string): string {\n    return join(this.baseDir, scope, key);");
    const coreRead = section(backend, "async read(scope: string, key: string): Promise<Uint8Array | undefined> {", "async *readStream(");
    expect(coreRead).toContain("const filePath = this.pathFor(scope, key);");
    expect(coreRead).toContain("bytes = await readFile(filePath);");
    expect(coreRead).toContain("if (isEnoent(error)) return undefined;");
    const coreWrite = section(backend, "async write(", "async writeStream(");
    expect(coreWrite).toContain("const filePath = this.pathFor(scope, key);");
    expect(coreWrite).toContain("await atomicWrite(filePath, data, undefined, this.fileMode, options.signal);");
    const bootstrap = read(`${CORE}/app/bootstrap/bootstrap.ts`);
    expect(bootstrap).toContain("import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';");
    expect(bootstrap).toContain("new SyncDescriptor(FileStorageService, [options.homeDir, 0o700, 0o600]);");
  });

  test("retry code preserves per-attempt settlement and cancellation", () => {
    const policy = read(`${CORE_RUNTIME}/llm/policy/policy.ts`);
    const settled = policy.indexOf("const result = await runAttempt(resolvedRequest, { signal, onEvent });");
    const retryIndex = policy.indexOf("if (shouldRetry(policy.retry, attempt, result.error, listOf(policy.retryables)))");
    const delayed = policy.indexOf("if (!(await delay(delayMs, signal)))");
    expect(settled).toBeGreaterThan(-1);
    expect(retryIndex).toBeGreaterThan(settled);
    expect(delayed).toBeGreaterThan(retryIndex);
    expect(policy).toContain("return abortedOf(result, signal.reason);");
    expect(policy.indexOf("attempt += 1;")).toBeGreaterThan(delayed);
    const retrySource = read(`${CORE_RUNTIME}/llm/policy/retry.ts`);
    expect(retrySource).toContain("return isRetryableError(error, extras) && attempt < resolveMaxAttempts(options);");
    expect(retrySource).toContain("error.kind === 'syntax' || error.kind === 'abort' || error.kind === 'context_overflow';");
    const settle = read(`${CORE_RUNTIME}/llm/policy/settle.ts`);
    expect(settle).toContain("if (isAbortError(error) || signal.aborted)");
    expect(settle).toContain("return aborted();");
    expect(settle).toContain("export async function runAttempt(");
    const retryBranch = policy.slice(retryIndex, policy.indexOf("attempt += 1;", retryIndex));
    expect(retryBranch).toContain("const invalidToolArguments = result.error.kind === 'invalid_tool_arguments';");
    expect(retryBranch).toContain("const delayMs = invalidToolArguments && policy.retry?.infiniteRetry !== true\n        ? 0");
    expect(retryBranch).toContain("if (!(await delay(delayMs, signal)))");
    expect(policy.slice(settled, retryIndex)).not.toContain("attempt += 1;");
    expect(read(`${CORE_RUNTIME}/llm/policy/credentials.ts`)).toContain(
      "appliedRecoveries.some((record) => record.strategy === 'credentials')",
    );
    const batch = read(`${CORE}/features/swarm/session/agentRunBatch.ts`);
    expect(batch).toContain("this.maxConcurrency !== undefined && this.active.size >= this.maxConcurrency");
    expect(batch).toContain("this.rateLimitCapacity += 1;");
  });

  test("structured errors retain swarm rate-limit classification", () => {
    const errors = read(`${CORE}/llm-adapter/contract/errors.ts`);
    expect(errors).toContain("if (error instanceof APIProviderQuotaExhaustedError) return false;");
    expect(errors).toContain("if (error instanceof APIProviderRateLimitError) return true;");
    expect(errors).toContain("if (statusCode !== undefined) return statusCode === 429;");
    const turn = read(`${CORE}/session/subagent/runAgentTurn.ts`);
    const direct = turn.indexOf("if (isProviderRateLimitError(error)) throw error;");
    const converted = turn.indexOf("if (payload.code === ErrorCodes.PROVIDER_RATE_LIMIT)");
    expect(direct).toBeGreaterThan(-1);
    expect(converted).toBeGreaterThan(direct);
    const response = read(`${CORE_RUNTIME}/llm/response.ts`);
    expect(response).toContain("| 'rate_limit'");
    expect(response).toContain("case 'rate_limit':");
    expect(response).toContain("return 'APIProviderRateLimitError';");
    const batch = read(`${CORE}/features/swarm/session/agentRunBatch.ts`);
    expect(batch).toContain("import { isProviderRateLimitError } from '#/llm-adapter/contract/errors';");
    expect(batch).toContain("if (isProviderRateLimitError(error)) {");
  });

  test("host task.background remains outside the model-tool detachment census", () => {
    const requests = read(`${KAP}/transport/ws/v1/taskRequests.ts`);
    expect(requests).toContain("const background = taskBackgroundMessageSchema.safeParse(frame);");
    expect(requests).toContain("handler?.detach();");
    expect(read(`${KAP}/transport/ws/v1/registerWsV1.ts`)).toContain("const taskSource = createTaskSource(core);");
  });

  test("other builtin model detachment callers remain the separately denied delegation and question tools", () => {
    expect(filesContaining([`${CORE}/agent/tools`, `${CORE}/features`], /\bdetach\?\.\(/)).toEqual([
      `${CORE}/agent/tools/agent/agentTool.ts`,
      `${CORE}/agent/tools/ask-user-question/askUserQuestionTool.ts`,
      `${CORE}/agent/tools/os/bash/bashTool.ts`,
      `${CORE}/features/tower/tools/spawn/spawnTool.ts`,
    ]);
    expect(read(`${CORE}/features/swarm/tools/agent-swarm/agentSwarmTool.ts`)).toContain("runInBackground: false,");
  });
});

function sourceIsGitClone(): boolean {
  if (SOURCE === undefined || !existsSync(SOURCE)) return false;
  try {
    const top = execFileSync("git", ["-C", SOURCE, "rev-parse", "--show-toplevel"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return realpathSync(top) === realpathSync(SOURCE);
  } catch {
    return false;
  }
}

const releaseTag = (version: string): string => `@moonshot-ai/kimi-code@${version}`;

function gitShow(version: string, rel: string): string {
  return execFileSync("git", ["-C", SOURCE!, "show", `${releaseTag(version)}:${rel}`], {
    encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Production .ts files at the tag that contain `needle` literally. */
function gitFilesContaining(version: string, needle: string): string[] {
  const tag = releaseTag(version);
  let out: string;
  try {
    out = execFileSync("git", ["-C", SOURCE!, "grep", "-l", "-F", "-e", needle, tag, "--", "*.ts"], {
      encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if ((error as { status?: number }).status === 1) return [];
    throw error;
  }
  return out.split("\n").filter(Boolean)
    .map((line) => line.slice(`${tag}:`.length))
    .filter((rel) => isProductionTs(rel) && !rel.includes("/tests/") && !rel.includes("/__tests__/"))
    .sort();
}

function orderedIndexes(source: string, needles: readonly string[], label: string): void {
  let previous = -1;
  for (const needle of needles) {
    const index = source.indexOf(needle, previous + 1);
    expect(index, `${label}: missing "${needle}" after the previous step`).toBeGreaterThan(previous);
    previous = index;
  }
}

function sliceBetween(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from, `missing ${JSON.stringify(start)}`).toBeGreaterThanOrEqual(0);
  const to = source.indexOf(end, from + start.length);
  expect(to, `missing ${JSON.stringify(end)} after ${JSON.stringify(start)}`).toBeGreaterThan(from);
  return source.slice(from, to);
}

// SHA-256 of each audited `taskWaitTool.ts` for certified rows (>= 2.8.0 floor).
const WAIT_FOR_TOOL_SOURCES: Readonly<Record<string, readonly string[]>> = {
  "2b6c62a2fc611c6bf27f998d76d3de98f072dde83e91e1fb4ea09fd9aa42dc35": ["2.8.0", "2.8.1"],
};

const releaseRowSuite = sourceIsGitClone() ? describe : describe.skip;

releaseRowSuite("per-release premises of the scope, flag and print relaxations (git tags, >= 2.8.0)", () => {
  for (const row of KIMI_V2_RELEASES) {
    const v = row.version;

    test(`${v}: the release tag is the row's audited commit and meets the 2.8.0 floor`, () => {
      expect(versionAtLeast(v, 2, 8), `${v} is below the 2.8.0 floor`).toBe(true);
      const commit = execFileSync("git", ["-C", SOURCE!, "rev-parse", `${releaseTag(v)}^{commit}`], {
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      expect(commit.startsWith(row.commit), `${releaseTag(v)} is ${commit}, the table says ${row.commit}`).toBe(true);
    });

    test(`${v}: a per-flag env override beats config and the master flag, and "0" parses false`, () => {
      const service = gitShow(v, `${CORE}/app/flag/flagService.ts`);
      expect(service).toContain("export const MASTER_ENV = 'KIMI_CODE_EXPERIMENTAL_FLAG';");
      const explain = service.slice(service.indexOf("explain(id: FlagId)"));
      orderedIndexes(explain, [
        "const override = parseBooleanEnv(this.bootstrap.getEnv(def.env));",
        "if (override !== undefined) return this.state(def, override, 'env', configValue);",
        "if (configValue !== undefined) return this.state(def, configValue, 'config', configValue);",
        "if (parseBooleanEnv(this.bootstrap.getEnv(MASTER_ENV)) === true) {",
      ], `${v} flagService.explain`);
      expect(service).toContain("return this.explain(id)?.enabled ?? false;");

      const env = gitShow(v, `${CORE}/_base/utils/env.ts`);
      const falseSet = /const FALSE_BOOLEAN_ENV_VALUES = new Set\(\[([^\]]*)\]\);/.exec(env)?.[1];
      const trueSet = /const TRUE_BOOLEAN_ENV_VALUES = new Set\(\[([^\]]*)\]\);/.exec(env)?.[1];
      expect(falseSet, `${v}: FALSE_BOOLEAN_ENV_VALUES not found`).toBeDefined();
      expect(falseSet!.split(",").map((item) => item.trim())).toContain("'0'");
      expect(trueSet!.split(",").map((item) => item.trim())).not.toContain("'0'");
      const parser = env.slice(env.indexOf("export function parseBooleanEnv("));
      orderedIndexes(parser, [
        "const normalized = value?.trim().toLowerCase();",
        "if (TRUE_BOOLEAN_ENV_VALUES.has(normalized)) return true;",
        "if (FALSE_BOOLEAN_ENV_VALUES.has(normalized)) return false;",
      ], `${v} parseBooleanEnv`);

      const tower = gitShow(v, `${CORE}/features/tower/flag.ts`);
      expect(tower).toContain("export const TOWER_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_TOWER';");
      expect(tower).toContain("env: TOWER_FLAG_ENV,");

      const listed = execFileSync("git", ["-C", SOURCE!, "ls-tree", "--name-only", releaseTag(v), "--", `${CORE}/session/subagent/flag.ts`], {
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      });
      expect(listed.trim(), `${v}: session/subagent/flag.ts is back`).toBe("");
      expect(gitFilesContaining(v, "subagent_fork")).toEqual([]);
      expect(gitFilesContaining(v, "SUBAGENT_FORK")).toEqual([]);
    });

    test(`${v}: WaitFor's whole service surface is waiting on, and reading, tasks that already exist`, () => {
      const tool = gitShow(v, `${CORE}/agent/tools/task/task-wait/taskWaitTool.ts`);
      expect(WAIT_FOR_TOOL_SOURCES[createHash("sha256").update(tool).digest("hex")] ?? [], `${v}: unread WaitFor source`).toContain(v);
      const unique = (pattern: RegExp): string[] => [...new Set([...tool.matchAll(pattern)].map((match) => match[1]!))].sort();
      expect(unique(/@(I[A-Za-z]+) /g), `${v}: injected services`).toEqual([
        "IAgentGoalService",
        "IAgentScopeContext",
        "IAgentTaskHistoryService",
        "IAgentToolExecutorService",
        "IFlagService",
        "ITelemetryService",
      ]);
      expect(unique(/this\.([a-zA-Z]+\.[a-zA-Z0-9]+)\(/g), `${v}: service calls`).toEqual([
        "flags.enabled",
        "goals.getGoal",
        "history.getTask",
        "telemetry.track2",
        "toolExecutor.handler",
        "toolExecutor.handlers",
      ]);
      expect(unique(/\bhandler\??\.(\w+)\b/g), `${v}: task handler members`).toEqual(["snapshot", "taskId", "wait"]);
      expect(unique(/(?<![.\w])tasks\.(\w+)\(/g), `${v}: calls through the progress helper's parameter`).toEqual(["list"]);
      expect(tool.split("startWaitProgress(").length - 1, `${v}: progress helper uses`).toBe(2);
      expect(tool, `${v}: what the progress helper is given`).toContain(
        "startWaitProgress(args, { list: () => this.listTasks() }, ctx.onUpdate, startedAt)",
      );
      const schema = gitShow(v, `${CORE}/agent/tools/task/task-wait/task-wait.ts`);
      expect(schema, `${v}: timeout cap applies`).toContain(".max(WAIT_FOR_MAX_TIMEOUT_S)");
      expect(schema, `${v}: cap`).toContain("export const WAIT_FOR_MAX_TIMEOUT_S = 90;");
    });

    test(`${v}: repeat breaker stops without the pre-2.6 handoff phase`, () => {
      const dedupe = gitShow(v, `${CORE}/agent/toolDedupe/toolDedupeService.ts`);
      expect(dedupe).toContain("wrapSystemReminder(");
      expect(dedupe.includes("if (this.handoffPhase === 'active') {"), `${v}: handoff phase`).toBe(false);
      expect(dedupe.includes("event.veto(HANDOFF_VETO_RESULT);"), `${v}: handoff veto`).toBe(false);
      expect(dedupe.includes("this.repeatBreakerStop = true;"), `${v}: stop without a handoff step`).toBe(true);
      expect(gitFilesContaining(v, "This turn was ended by the repeat breaker after the same tool call was issued ")).toEqual([]);
      expect(gitFilesContaining(v, "Tool skipped because a previous tool call stopped the turn.")).toEqual([]);
    });

    test(`${v}: the scoped read and web tools are default-approved, so the hook is their only gate`, () => {
      const policy = gitShow(v, `${CORE}/agent/permissionPolicy/policies/default-tool-approve.ts`);
      const list = /const DEFAULT_APPROVE_TOOLS = new Set\(\[([^\]]*)\]\);/.exec(policy)?.[1];
      expect(list, `${v}: DEFAULT_APPROVE_TOOLS not found`).toBeDefined();
      const tools = list!.split(",").map((item) => item.trim().replace(/^'|'$/g, "")).filter(Boolean);
      for (const tool of ["Read", "Grep", "Glob", "ReadMediaFile", "WebSearch", "FetchURL"]) {
        expect(tools, `${v}: ${tool} must be default-approved`).toContain(tool);
      }
    });

    test(`${v}: Bash runs each call as cd <cwd> && <command> in a fresh shell`, () => {
      const bash = gitShow(v, `${CORE}/agent/tools/os/bash/bashTool.ts`);
      expect(bash).toContain("const shellCommand = `cd ${shellQuote(shellCwd)} && ${command}`;");
      const spawn = /return processService\.spawn\(env\.shellPath, \['-c', shellCommand\], (\{[^}]*\})\);/.exec(bash);
      expect(spawn, `${v}: Bash no longer spawns ['-c', shellCommand] per call`).not.toBeNull();
      console.log(`[tag-scan] ${v} Bash spawn options: ${spawn![1]}`);
    });
  }

  for (const v of kimiVersionsWith("print-cancels-plan")) {
    test(`${v}: print cancels the create-time plan enter, the setting's only consumer`, () => {
      const print = gitShow(v, `${CLI}/cli/v2/run-v2-print.ts`);
      orderedIndexes(print, [
        "const session = await sessions.create({",
        "const plan = agent.accessor.get(IAgentPlanService);",
        "if ((await plan.status()) !== null) {",
        "plan.cancel();",
      ], `${v} run-v2-print`);

      const section = `${CORE}/features/plan/configSection.ts`;
      const lifecycle = `${CORE}/workspace/sessionLifecycle/sessionLifecycleService.ts`;
      expect(gitFilesContaining(v, "DEFAULT_PLAN_MODE_SECTION")).toEqual([section, lifecycle]);
      const registration = gitShow(v, section);
      expect(registration.split("DEFAULT_PLAN_MODE_SECTION").length - 1).toBe(2);
      expect(registration).toContain("export const DEFAULT_PLAN_MODE_SECTION = 'defaultPlanMode';");
      expect(registration).toContain("registerConfigSection(DEFAULT_PLAN_MODE_SECTION,");

      const source = gitShow(v, lifecycle);
      const uses: number[] = [];
      for (let at = source.indexOf("DEFAULT_PLAN_MODE_SECTION"); at !== -1; at = source.indexOf("DEFAULT_PLAN_MODE_SECTION", at + 1)) {
        uses.push(at);
      }
      expect(uses, `${v}: expected the import and one read`).toHaveLength(2);
      expect(source.slice(source.lastIndexOf("\n", uses[0]!) + 1, uses[0]!)).toBe("import { ");
      const create = source.indexOf("  async create(opts: CreateSessionOptions)");
      const createEnd = source.indexOf("\n  }\n", create);
      expect(create).toBeGreaterThan(-1);
      expect(uses[1]!, `${v}: the read must sit inside sessionLifecycleService.create()`).toBeGreaterThan(create);
      expect(uses[1]!).toBeLessThan(createEnd);
    });
  }

  for (const v of kimiVersionsWith("local-environment")) {
    test(`${v}: session creation prefers the explicit environment id over the configured default`, () => {
      const manager = gitShow(v, `${CORE}/app/sessionManager/sessionManagerService.ts`);
      const creation = manager.slice(manager.indexOf("private async openCreation("));
      orderedIndexes(creation, [
        "const declarations = options.environmentId === LOCAL_ENVIRONMENT_ID",
        "const environmentId = options.environmentId ?? declarations?.defaultId;",
      ], `${v} sessionManagerService.openCreation`);
    });
  }
});
