import { z } from 'zod';

export const TeamReviewWatcheeSettings = z.object({
  enabled: z.boolean(),
  org: z.string(),
  teams: z.array(z.object({ org: z.string().min(1), slug: z.string().min(1) }).strict()),
  intervalMinutes: z.number().positive(),
}).strict();

export type TeamReviewWatcheeSettings = z.infer<typeof TeamReviewWatcheeSettings>;

export const MyPrsWatcheeSettings = z.object({
  enabled: z.boolean(),
  org: z.string(),
  intervalMinutes: z.number().positive(),
}).strict();

export type MyPrsWatcheeSettings = z.infer<typeof MyPrsWatcheeSettings>;

export const WorkflowsWatcheeSettings = z.object({
  enabled: z.boolean(),
  repos: z.array(z.string().min(1)),
  intervalMinutes: z.number().positive(),
}).strict();

export type WorkflowsWatcheeSettings = z.infer<typeof WorkflowsWatcheeSettings>;

export const IssuesWatcheeSettings = z.object({
  enabled: z.boolean(),
  projectRepos: z.array(z.string().min(1)),
  teams: z.array(z.string().min(1)),
  intervalMinutes: z.number().positive(),
}).strict();

export type IssuesWatcheeSettings = z.infer<typeof IssuesWatcheeSettings>;

export const WatcheeSettingsFile = z.object({
  version: z.literal(1),
  teamReview: TeamReviewWatcheeSettings,
  myPrs: MyPrsWatcheeSettings,
  workflows: WorkflowsWatcheeSettings,
  issues: IssuesWatcheeSettings,
}).strict();

export type WatcheeSettingsFile = z.infer<typeof WatcheeSettingsFile>;

export const WATCHEE_SETTINGS_FILENAME = 'watchees.json';
export const SENT_EVENTS_FILENAME = 'sent-events.json';
export const WATCHER_HOME_ENV = 'GLIMMERVOID_WATCHER_HOME';
