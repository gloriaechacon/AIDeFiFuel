import styles from "./button.module.css";

export function Button(props: React.ButtonHTMLAttributes<HTMLButtonElement>){
    const { className, ...rest} = props;
    return <button className={`${styles.button} ${className ?? ""}`} {...rest} />;
}