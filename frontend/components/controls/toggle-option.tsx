import styles from "./controls-bar.module.css";

export function ToggleOption({
    label,
    active,
    onClick
}: {
    label: string;
    active: boolean;
    onClick: () => void;
}) {
    return (
        <button
            className={`${styles.toggleOption} ${active ? styles.active : ""}`}
            onClick={onClick}
            type="button"
        >
            {label}
        </button>
    );
}