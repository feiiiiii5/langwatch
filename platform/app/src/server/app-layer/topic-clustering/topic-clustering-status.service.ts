import { TOPIC_CLUSTERING_STALE_RUN_MS } from "~/server/event-sourcing/pipelines/topic-clustering-processing/process-manager/topicClustering.process";
import type { TopicClusteringRunHistoryEntry } from "~/server/event-sourcing/pipelines/topic-clustering-processing/projections/topicClusteringRunHistory.foldProjection";
import { TOPIC_CLUSTERING_RUN_OUTCOME } from "~/server/event-sourcing/pipelines/topic-clustering-processing/schemas/constants";
import type { TopicClusteringStatusRepository } from "./repositories/topic-clustering-status.repository";

/**
 * The two read-model projections this service reads, named exactly as the
 * `topic_clustering_processing` pipeline declares them, so the composition
 * root can wire this to the same kill-switch check the projection router
 * applies before folding events.
 */
export type TopicClusteringProjectionName =
  | "topicClusteringRunStatus"
  | "topicClusteringRunHistory";

/**
 * Whether the event-sourcing kill switch currently disables one of those
 * projections for a project. The composition root wires this to
 * `isComponentDisabled` — the same function, aggregate type, component type
 * and key shape the projection router consults to skip folding — so the read
 * side and the write side cannot disagree about what is paused. When no check
 * is wired (or the check errors), values read as current, matching the
 * router's fail-open: events fold when the flag service is absent.
 */
export type IsTopicClusteringProjectionDisabled = (params: {
  projectionName: TopicClusteringProjectionName;
  projectId: string;
}) => Promise<boolean>;

export interface TopicClusteringStatus {
  lastRequestedAt: number | null;
  lastRequestTrigger: string | null;
  lastRunAt: number | null;
  /** completed | skipped | failed */
  lastRunOutcome: string | null;
  lastRunMode: string | null;
  lastRunSkippedReason: string | null;
  /**
   * Deliberately absent: the raw error text. It is a provider/langevals
   * response body — Python tracebacks, internal hostnames, echoed key
   * prefixes — and gating its release on a regex classifier means one
   * mis-scoped pattern turns into a disclosure. `lastRunErrorCode` is the
   * whole contract with the UI; fixed copy is chosen from it. The raw text
   * stays in the projection for operators. See ADR-051 §8.
   */
  lastRunErrorCode: string | null;
  /** True when the customer can resolve the failure themselves. */
  isLastRunErrorUserActionable: boolean;
  lastRunTracesProcessed: number;
  lastRunTopicsCount: number;
  lastRunSubtopicsCount: number;
  /**
   * A run is working right now, as recorded by `run_started`. The effect
   * announces every page before working it, so this covers scheduled and
   * manual runs alike, from the first page, including runs that finish in a
   * single page. Cleared by the terminal `run_completed` / `run_failed` —
   * and, because that terminal write is best-effort and can be lost, ALSO
   * bounded by the scheduler's stale-run window from the run's start. An
   * unbounded read here pinned the badge to "Running" and made the route
   * refuse "Run now" until the next daily wake, even though the process
   * itself would have preempted the dead run.
   */
  isInProgress: boolean;
  /**
   * Whether a run is underway, including one that has been asked for but has
   * not reached the effect yet.
   *
   * `isInProgress` is the recorded fact and covers a run from the moment it
   * starts working. It cannot cover the gap BEFORE that: a manual request is
   * committed as an event, the process turns it into an intent, and the
   * outbox dispatches it — usually seconds, but longer under a backlog. In
   * that gap the only evidence is the request itself, so a request with no
   * outcome after it still reads as in-flight.
   *
   * That inference is bounded by the same window the scheduler uses to
   * abandon a run, so a request whose run died before announcing itself stops
   * reading as "running" at the moment a new request would preempt it,
   * instead of pinning the UI to "Running" forever.
   */
  isRunInFlight: boolean;
  /**
   * True when the run-status projection is currently paused by its kill
   * switch. The router then skips this projection's events, so everything
   * above stopped updating: these are the LAST STORED values, not the state
   * of a recent run, and the Settings page must say so instead of implying
   * freshness. False when no kill-switch check is wired or the check errors —
   * the same fail-open the router applies (events fold when it cannot
   * decide). The switch has a cache TTL, so the flag can lag the operator's
   * change by up to that TTL.
   */
  isStatusStale: boolean;
  /**
   * Same as `isStatusStale`, for the run-history projection and the read
   * model served by `getRunHistoryByProjectId`.
   */
  isRunHistoryStale: boolean;
  /** Epoch ms of the next scheduled daily run, or null when unscheduled. */
  nextRunAt: number | null;
}

/** Serves the settings page's clustering status read (ADR-051 §7). */
export class TopicClusteringStatusService {
  constructor(
    private readonly repository: TopicClusteringStatusRepository,
    private readonly now: () => number = Date.now,
    private readonly isProjectionDisabled?: IsTopicClusteringProjectionDisabled,
  ) {}

  async getByProjectId(params: {
    projectId: string;
  }): Promise<TopicClusteringStatus> {
    const { projection, nextWakeAt } =
      await this.repository.findByProjectId(params);

    // Ask the SAME check the router asks before folding. Each flag tracks
    // its own projection: a paused run-status projection freezes the values
    // below, a paused run-history projection freezes the history, and each
    // flag tracks only its own projection. Unwired or erroring, both read
    // false.
    const [isStatusStale, isRunHistoryStale] = this.isProjectionDisabled
      ? await Promise.all([
          this.isProjectionDisabled({
            projectionName: "topicClusteringRunStatus",
            projectId: params.projectId,
          }),
          this.isProjectionDisabled({
            projectionName: "topicClusteringRunHistory",
            projectId: params.projectId,
          }),
        ])
      : [false, false];

    const lastRequestedAt = projection?.LastRequestedAt ?? null;
    const lastRunAt = projection?.LastRunAt ?? null;
    const isInProgress =
      projection?.InProgressRunId != null &&
      this.now() -
        // Rows folded before the column existed fall back to the latest
        // applied event's business time — later than the true start, so the
        // bound only ever errs toward "still running" for one extra window.
        (projection.InProgressStartedAt ?? projection.OccurredAt) <
        TOPIC_CLUSTERING_STALE_RUN_MS;

    return {
      lastRequestedAt,
      lastRequestTrigger: projection?.LastRequestTrigger ?? null,
      lastRunAt,
      lastRunOutcome: projection?.LastRunOutcome ?? null,
      lastRunMode: projection?.LastRunMode ?? null,
      lastRunSkippedReason: projection?.LastRunSkippedReason ?? null,
      lastRunErrorCode: projection?.LastRunErrorCode ?? null,
      isLastRunErrorUserActionable:
        projection?.LastRunErrorUserActionable ?? false,
      lastRunTracesProcessed: projection?.LastRunTracesProcessed ?? 0,
      lastRunTopicsCount: projection?.LastRunTopicsCount ?? 0,
      lastRunSubtopicsCount: projection?.LastRunSubtopicsCount ?? 0,
      isInProgress,
      isRunInFlight:
        isInProgress ||
        this.hasUnansweredRequest({
          lastRequestedAt,
          lastRunAt,
          lastRequestTrigger: projection?.LastRequestTrigger ?? null,
        }),
      isStatusStale,
      isRunHistoryStale,
      nextRunAt: nextWakeAt?.getTime() ?? null,
    };
  }

  /**
   * The project's recent runs, newest first, from the bounded history read
   * model. Entries still reading as "running" past the scheduler's stale-run
   * window are presented as abandoned — their terminal outcome was lost and
   * the scheduler has already moved on, so the UI must not show them as
   * working forever. Raw error text is never part of this model (ADR-051 §8).
   */
  async getRunHistoryByProjectId(params: {
    projectId: string;
  }): Promise<TopicClusteringRunHistoryEntry[]> {
    const runs = await this.repository.findRunHistoryByProjectId(params);
    return runs.map((run) =>
      run.outcome === TOPIC_CLUSTERING_RUN_OUTCOME.RUNNING &&
      this.now() - run.startedAt >= TOPIC_CLUSTERING_STALE_RUN_MS
        ? { ...run, outcome: TOPIC_CLUSTERING_RUN_OUTCOME.ABANDONED }
        : run,
    );
  }

  /**
   * Whether asking for a run right now would be answered by one already
   * underway rather than starting a new one. Same signal the settings page
   * renders, so the button and the badge can never disagree.
   */
  async isRunInFlight(params: { projectId: string }): Promise<boolean> {
    const status = await this.getByProjectId(params);
    return status.isRunInFlight;
  }

  private hasUnansweredRequest(params: {
    lastRequestedAt: number | null;
    lastRunAt: number | null;
    lastRequestTrigger: string | null;
  }): boolean {
    const { lastRequestedAt, lastRunAt, lastRequestTrigger } = params;
    if (lastRequestedAt === null) return false;
    // Only a MANUAL ask can go unanswered. A bootstrap request deliberately
    // starts no run -- it just ensures the process exists and its wake is
    // scheduled -- so treating one as in-flight reports "Running" for a
    // project where nothing is running, and makes "Run now" refuse. Bootstrap
    // requests are also re-asserted on ingest, so this would latch on
    // permanently for every active project rather than clearing after the
    // stale window.
    if (lastRequestTrigger !== "manual") return false;
    if (lastRunAt !== null && lastRunAt >= lastRequestedAt) return false;
    return this.now() - lastRequestedAt < TOPIC_CLUSTERING_STALE_RUN_MS;
  }
}
