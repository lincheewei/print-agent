module.exports = {
    apps: [
        {
            name: "print-agent",
            script: "server.js",
            cwd: "C:/print-agent",

            // 🔁 reliability
            autorestart: true,
            watch: false,
            max_restarts: 999,

            // ⏱ startup delay (important for USB / COM ports)
            restart_delay: 3000,

            // 🧠 memory safety
            max_memory_restart: "300M",

            // 📜 logs
            error_file: "logs/err.log",
            out_file: "logs/out.log",
            merge_logs: true,
            time: true,

            // 🌍 env
            env: {
                NODE_ENV: "production",
                PORT: 3001
            }
        }
    ]
};