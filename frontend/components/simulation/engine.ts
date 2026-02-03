import { TimelineEvent, TimelineEventType } from "../simulation/types";

export function formatTime(timestamp: number) {
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], { hour12: false});
}

export function createTimelineEvent (
    type: TimelineEventType,
    title: string,
    description: string,
    opts?: Partial<TimelineEvent>
): TimelineEvent {
    return {
        id: crypto.randomUUID(),
        type,
        title,
        description,
        timestamp: Date.now(),
        status: "info",
        ...opts,
    };
}