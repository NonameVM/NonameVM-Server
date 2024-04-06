export default function log(loglevel, ...message) {
    console[(loglevel === "ERROR" || loglevel === "FATAL") ? "error" :
        (loglevel === "WARN") ? "warn" :
            "log"](`[${new Date().toLocaleString()}] [${loglevel}]`, ...message);
}
