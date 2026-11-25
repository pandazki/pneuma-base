// The names a plugin claims, which no one else may hold: its `say` kinds, owner command names and view ids.

/** The kernel's own owner commands. No plugin command takes one of these names. */
export const KERNEL_COMMAND_NAMES = ['grant issue', 'grant revoke', 'plugin add', 'plugin remove', 'skill install', 'archive purge'] as const
export type KernelCommandName = (typeof KERNEL_COMMAND_NAMES)[number]
