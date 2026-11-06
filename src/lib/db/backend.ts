/** Which database the app runs on. Changing the App Setting and restarting switches it back. */
export function usesSqlServer() {
  return process.env.DATA_BACKEND === "sqlserver";
}
