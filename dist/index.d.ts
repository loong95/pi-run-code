import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export interface RunCodeConfig {
    /** Maximum wall-clock duration of one program, in milliseconds. */
    maxWallMs?: number;
    /** Maximum measured worker busy time, in milliseconds. */
    maxComputeMs?: number;
    /** Maximum serialized size of logs plus the returned value, in bytes. */
    maxOutputBytes?: number;
    /** Which presentation to use. `both` keeps pi's native tools active. */
    mode?: "ptc" | "both";
}
export default function runCodeExtension(pi: ExtensionAPI): void;
