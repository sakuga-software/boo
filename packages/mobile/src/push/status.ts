import type { PushStatus } from './register';

/** The line of the settings screen on the push notifications of this phone. */
export function pushLine(status: PushStatus): string {
  switch (status.status) {
    case 'registered':
      return 'This phone gets a notification when a pull request changes to a state turned on below.';
    case 'denied':
      return 'The notifications of boo are off on this phone: turn them on in the settings of the system.';
    case 'unavailable':
      return status.reason;
    case 'failed':
      return `This phone is not registered: ${status.message}`;
    default:
      return 'Registering this phone…';
  }
}
