import "server-only";
// Registers every REAL connector. Importing this module (API routes, the worker) makes them available
// to the registry; nothing else in the platform names a specific connector.
// (Connectors are added milestone by milestone: the generic signed webhook first, Telegram in P1.)
export {};
