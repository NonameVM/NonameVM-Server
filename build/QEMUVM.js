import * as rfb from 'rfb2';
import * as fs from 'fs';
import { execaCommand } from "execa";
import QMPClient from "./QMPClient.js";
import BatchRects from "./RectBatcher.js";
import { createCanvas, createImageData } from "canvas";
import { Mutex } from "async-mutex";
import log from "./log.js";
import VM from "./VM.js";
export default class QEMUVM extends VM {
    vnc;
    vncPort;
    framebuffer;
    framebufferCtx;
    qmpSock;
    qmpType;
    qmpClient;
    qemuCmd;
    qemuProcess;
    qmpErrorLevel;
    vncErrorLevel;
    processRestartErrorLevel;
    expectedExit;
    vncOpen;
    vncUpdateInterval;
    rects;
    rectMutex;
    vncReconnectTimeout;
    qmpReconnectTimeout;
    qemuRestartTimeout;
    constructor(Config) {
        super();
        if (Config.vm.vncPort < 5900) {
            log("FATAL", "VNC port must be 5900 or higher");
            process.exit(1);
        }
        Config.vm.qmpSockDir == null ? this.qmpType = "tcp:" : this.qmpType = "unix:";
        if (this.qmpType == "tcp:") {
            this.qmpSock = `${Config.vm.qmpHost}:${Config.vm.qmpPort}`;
        }
        else {
            this.qmpSock = `${Config.vm.qmpSockDir}collab-vm-qmp-${Config.collabvm.node}.sock`;
        }
        this.vncPort = Config.vm.vncPort;
        this.qemuCmd = `${Config.vm.qemuArgs} -no-shutdown -vnc 127.0.0.1:${this.vncPort - 5900} -qmp ${this.qmpType}${this.qmpSock},server,nowait`;
        if (Config.vm.snapshots)
            this.qemuCmd += " -snapshot";
        this.qmpErrorLevel = 0;
        this.vncErrorLevel = 0;
        this.vncOpen = true;
        this.rects = [];
        this.rectMutex = new Mutex();
        this.framebuffer = createCanvas(1, 1);
        this.framebufferCtx = this.framebuffer.getContext("2d");
        this.processRestartErrorLevel = 0;
        this.expectedExit = false;
        this.qmpClient = new QMPClient(this.qmpSock, this.qmpType);
        this.qmpClient.on('connected', () => this.qmpConnected());
        this.qmpClient.on('close', () => this.qmpClosed());
    }
    Start() {
        return new Promise(async (res, rej) => {
            if (fs.existsSync(this.qmpSock))
                try {
                    fs.unlinkSync(this.qmpSock);
                }
                catch (e) {
                    log("ERROR", `Failed to delete existing socket: ${e}`);
                    process.exit(-1);
                }
            this.qemuProcess = execaCommand(this.qemuCmd);
            this.qemuProcess.catch(() => false);
            this.qemuProcess.stderr?.on('data', (d) => log("ERROR", `QEMU sent to stderr: ${d.toString()}`));
            this.qemuProcess.once('spawn', () => {
                setTimeout(async () => {
                    await this.qmpClient.connect();
                }, 2000);
            });
            this.qemuProcess.once('exit', () => {
                if (this.expectedExit)
                    return;
                clearTimeout(this.qmpReconnectTimeout);
                clearTimeout(this.vncReconnectTimeout);
                this.processRestartErrorLevel++;
                if (this.processRestartErrorLevel > 4) {
                    log("FATAL", "QEMU failed to launch 5 times.");
                    process.exit(-1);
                }
                log("WARN", "QEMU exited unexpectedly, retrying in 3 seconds");
                this.qmpClient.disconnect();
                this.vnc?.end();
                this.qemuRestartTimeout = setTimeout(() => this.Start(), 3000);
            });
            this.qemuProcess.on('error', () => false);
            this.once('vncconnect', () => res());
        });
    }
    qmpConnected() {
        this.qmpErrorLevel = 0;
        this.processRestartErrorLevel = 0;
        log("INFO", "QMP Connected");
        setTimeout(() => this.startVNC(), 1000);
    }
    startVNC() {
        this.vnc = rfb.createConnection({
            host: "127.0.0.1",
            port: this.vncPort,
        });
        this.vnc.on("close", () => this.vncClosed());
        this.vnc.on("connect", () => this.vncConnected());
        this.vnc.on("rect", (r) => this.onVNCRect(r));
        this.vnc.on("resize", (s) => this.onVNCSize(s));
    }
    getSize() {
        if (!this.vnc)
            return { height: 0, width: 0 };
        return { height: this.vnc.height, width: this.vnc.width };
    }
    qmpClosed() {
        if (this.expectedExit)
            return;
        this.qmpErrorLevel++;
        if (this.qmpErrorLevel > 4) {
            log("FATAL", "Failed to connect to QMP after 5 attempts");
            process.exit(1);
        }
        log("ERROR", "Failed to connect to QMP, retrying in 3 seconds.");
        this.qmpReconnectTimeout = setTimeout(() => this.qmpClient.connect(), 3000);
    }
    vncClosed() {
        this.vncOpen = false;
        if (this.expectedExit)
            return;
        this.vncErrorLevel++;
        if (this.vncErrorLevel > 4) {
            log("FATAL", "Failed to connect to VNC after 5 attempts.");
            process.exit(1);
        }
        try {
            this.vnc?.end();
        }
        catch { }
        ;
        log("ERROR", "Failed to connect to VNC, retrying in 3 seconds");
        this.vncReconnectTimeout = setTimeout(() => this.startVNC(), 3000);
    }
    vncConnected() {
        this.vncOpen = true;
        this.emit('vncconnect');
        log("INFO", "VNC Connected");
        this.vncErrorLevel = 0;
        this.onVNCSize({ height: this.vnc.height, width: this.vnc.width });
        this.vncUpdateInterval = setInterval(() => this.SendRects(), 33);
    }
    onVNCRect(rect) {
        return this.rectMutex.runExclusive(async () => {
            return new Promise(async (res, rej) => {
                var buff = Buffer.alloc(rect.height * rect.width * 4);
                var offset = 0;
                for (var i = 0; i < rect.data.length; i += 4) {
                    buff[offset++] = rect.data[i + 2];
                    buff[offset++] = rect.data[i + 1];
                    buff[offset++] = rect.data[i];
                    buff[offset++] = 255;
                }
                var imgdata = createImageData(Uint8ClampedArray.from(buff), rect.width, rect.height);
                this.framebufferCtx.putImageData(imgdata, rect.x, rect.y);
                this.rects.push({
                    x: rect.x,
                    y: rect.y,
                    height: rect.height,
                    width: rect.width,
                    data: buff,
                });
                if (!this.vnc)
                    throw new Error();
                if (this.vncOpen)
                    this.vnc.requestUpdate(true, 0, 0, this.vnc.height, this.vnc.width);
                res();
            });
        });
    }
    SendRects() {
        if (!this.vnc || this.rects.length < 1)
            return;
        return this.rectMutex.runExclusive(() => {
            return new Promise(async (res, rej) => {
                var rect = await BatchRects(this.framebuffer, [...this.rects]);
                this.rects = [];
                this.emit('dirtyrect', rect.data, rect.x, rect.y);
                res();
            });
        });
    }
    onVNCSize(size) {
        if (this.framebuffer.height !== size.height)
            this.framebuffer.height = size.height;
        if (this.framebuffer.width !== size.width)
            this.framebuffer.width = size.width;
        this.emit("size", { height: size.height, width: size.width });
    }
    Reboot() {
        return new Promise(async (res, rej) => {
            if (this.expectedExit) {
                res();
                return;
            }
            res(await this.qmpClient.reboot());
        });
    }
    async Restore() {
        if (this.expectedExit)
            return;
        await this.Stop();
        this.expectedExit = false;
        this.Start();
    }
    Stop() {
        return new Promise(async (res, rej) => {
            if (this.expectedExit) {
                res();
                return;
            }
            if (!this.qemuProcess)
                throw new Error("VM was not running");
            this.expectedExit = true;
            this.vncOpen = false;
            this.vnc?.end();
            clearInterval(this.vncUpdateInterval);
            var killTimeout = setTimeout(() => {
                log("WARN", "Force killing QEMU after 10 seconds of waiting for shutdown");
                this.qemuProcess?.kill(9);
            }, 10000);
            var closep = new Promise(async (reso, reje) => {
                this.qemuProcess?.once('exit', () => reso());
                await this.qmpClient.execute({ "execute": "quit" });
            });
            var qmpclosep = new Promise((reso, rej) => {
                this.qmpClient.once('close', () => reso());
            });
            await Promise.all([closep, qmpclosep]);
            clearTimeout(killTimeout);
            res();
        });
    }
    pointerEvent(x, y, mask) {
        if (!this.vnc)
            throw new Error("VNC was not instantiated.");
        this.vnc.pointerEvent(x, y, mask);
    }
    acceptingInput() {
        return this.vncOpen;
    }
    keyEvent(keysym, down) {
        if (!this.vnc)
            throw new Error("VNC was not instantiated.");
        this.vnc.keyEvent(keysym, down ? 1 : 0);
    }
}
