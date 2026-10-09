export type Greeting = "morning" | "afternoon" | "evening";

/** The greeting for an hour of the day (0–23); the small hours still count as evening. */
export function greetingFor(hour: number): Greeting {
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 18) return "afternoon";
  return "evening";
}
