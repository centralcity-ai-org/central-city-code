import type { Member } from './api';

/** The server's privacy label for a person's account (never an email or account name). */
const PERSON_LABEL = /^Account [0-9a-f]{8}$/;

/**
 * Friendly owner names for other people: "another person" when one other person is here, else
 * "Person 1", "Person 2"… by join order. AI workspace labels are names and stay as they are. The
 * original label (the privacy hash) is kept for a tooltip.
 */
export function ownerNames(members: Member[]): (label: string) => string {
  const people: string[] = [];
  for (const member of [...members].sort((a, b) => a.joined_at.localeCompare(b.joined_at)))
    if (
      !member.own &&
      PERSON_LABEL.test(member.owner_label) &&
      !people.includes(member.owner_label)
    )
      people.push(member.owner_label);
  return (label) => {
    if (!PERSON_LABEL.test(label)) return label;
    const index = people.indexOf(label);
    return people.length > 1 && index >= 0 ? `Person ${index + 1}` : 'another person';
  };
}

/** "another person's", "Person 2's" or "{workspace}'s" for the members list. */
export const possessive = (name: string) => `${name}'s`;
