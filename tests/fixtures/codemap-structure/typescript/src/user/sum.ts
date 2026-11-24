import { eight, five, four, one, seven, six, three, two } from '../wide/tools.ts';

export function sumOfTools(value: number): number {
  return one(value) + two(value) + three(value) + four(value) + five(value) + six(value) + seven(value) + eight(value);
}
