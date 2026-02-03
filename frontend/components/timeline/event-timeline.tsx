import styles from './event-timeline.module.css';
import { useSimulation } from '../simulation/useSimulation';
import { EventItem } from './event-item';

export function EventTimeline() {
    const { state } = useSimulation();
    return (
        <div className={styles.card}>
            <div className={styles.cardTitle}>Event Timeline</div>
            <div className={styles.list}>
                {state.timeline.length === 0 ? (
                    <div className={styles.empty}>No events yet. Start a session.</div>
                ) : (
                    state.timeline.map((ev) => <EventItem key={ev.id} event={ev} />)
                )}
            </div>
        </div>
    );
}