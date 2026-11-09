/**
 * Holds one registration at a time. A registration asks the system for the device token, and the
 * system then tells that token to the token listener; the prompt also sends the app to the background
 * and back. While a registration runs, neither may start another one.
 *
 * Each run has a number. Only the end of the last run that started frees the gate: a run that a newer
 * one replaced (another session, another attempt) ends late and changes nothing (finding #710d10).
 */
export function registrationGate() {
  let last = 0;
  let running = false;
  return {
    /** Starts a run, and gives its number. */
    start(): number {
      running = true;
      return ++last;
    },
    /** Ends the run `run`. A run that a newer one replaced does not free the gate. */
    end(run: number): void {
      if (run === last) running = false;
    },
    /** True while a run has not ended. */
    get running(): boolean {
      return running;
    },
  };
}
