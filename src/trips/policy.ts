import { PAPER_TRIP_POLICY, type Trip } from './model';
/** Separate selection from legacy policy replay and test-ASN build gates. */
export function newTripPolicy(_privatePilot: boolean): Trip['policy'] {
  return { ...PAPER_TRIP_POLICY };
}
