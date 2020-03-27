import https from "https";
import http from "http";
import WS from "ws";
import { EventEmitter } from "events";
import _Telnet from "./telnet";
import { v4 } from "uuid";

class WST extends EventEmitter {
    public readonly UUID: string = v4();
    private socket: WS;
    public readonly options: _Telnet.TelnetOptionMatrix = new _Telnet.TelnetOptionMatrix();
    private responder: Nullable<(data: string) => void> = null;
    constructor(socket: WS) {
        super();
        this.socket = socket;
        this.socket.on("open", () => this.emit("open"));
        this.socket.on("close", (code, reason) => this.emit("close", code, reason));
        this.socket.on("error", (err) => this.emit("error", err));
        this.socket.on("ping", (data) => this.emit("ping", data));
        this.socket.on("pong", (data) => this.emit("pong", data));
        this.socket.on("message", (data) => {
            if (data instanceof Buffer) {
                // Binary
                this.HandleData(data);
            } else if (data instanceof ArrayBuffer) {
                // Binary arraybuffer?
                this.HandleData(Buffer.from(data));
            } else if (typeof data === "string") {
                this.HandleData(Buffer.from(data, "utf-8"));
            }
        });
    }
    public close(code?: number, reason?: string): void {
        this.socket.close(code, reason);
    }
    public send(data: Buffer): void;
    public send(data: string): void;
    public send(data: Buffer | string): void {
        this.socket.send(data);
    }
    private sendTelnet(command: _Telnet.TelnetNegotiation, option: _Telnet.TelnetOption, data?: Buffer): void {
        switch (command) {
            case _Telnet.TelnetNegotiation.SB:
                if (data !== undefined) {
                    this.send(
                        Buffer.from([
                            _Telnet.TelnetNegotiation.IAC,
                            command,
                            option,
                            ...data,
                            _Telnet.TelnetNegotiation.IAC,
                            _Telnet.TelnetNegotiation.SE,
                        ]),
                    );
                } else {
                    this.send(
                        Buffer.from([
                            _Telnet.TelnetNegotiation.IAC,
                            command,
                            option,
                            0,
                            _Telnet.TelnetNegotiation.IAC,
                            _Telnet.TelnetNegotiation.SE,
                        ]),
                    );
                }
                break;
            default:
                this.send(Buffer.from([_Telnet.TelnetNegotiation.IAC, command, option]));
                break;
        }
    }
    public sendSubnegotiation(option: _Telnet.TelnetOption, data: Buffer): void;
    public sendSubnegotiation(option: _Telnet.TelnetOption, data: string): void;
    public sendSubnegotiation(option: _Telnet.TelnetOption, data: Buffer | string): void {
        if (typeof data === "string") {
            data = Buffer.from(data, "utf-8");
        }
        this.sendTelnet(_Telnet.TelnetNegotiation.SB, option, data);
    }
    public sendGMCP(namespace: string, data: string): void;
    public sendGMCP(namespace: string, data: { [key: string]: any }): void;
    public sendGMCP(namespace: string, data: { [key: string]: any } | string): void {
        if (!this.options.HasOption(_Telnet.TelnetOption.GMCP)) return;
        if (typeof data === "object") {
            // Convert object to JSON.
            data = JSON.stringify(data);
        }
        this.sendSubnegotiation(_Telnet.TelnetOption.GMCP, `${namespace} ${data}`);
    }
    public will(option: _Telnet.TelnetOption): void {
        if (this.options.GetState(option) === _Telnet.TelnetOptionState.DISABLED) {
            this.options.SetState(option, _Telnet.TelnetOptionState.WAITING);
            this.sendTelnet(_Telnet.TelnetNegotiation.WILL, option);
        }
    }
    public wont(option: _Telnet.TelnetOption): void {
        if (this.options.GetState(option) === _Telnet.TelnetOptionState.DISABLED) {
            this.options.SetState(option, _Telnet.TelnetOptionState.WAITING);
            this.sendTelnet(_Telnet.TelnetNegotiation.WONT, option);
        }
    }
    public do(option: _Telnet.TelnetOption): void {
        if (this.options.GetState(option) === _Telnet.TelnetOptionState.DISABLED) {
            this.options.SetState(option, _Telnet.TelnetOptionState.WAITING);
            this.sendTelnet(_Telnet.TelnetNegotiation.DO, option);
        }
    }
    public dont(option: _Telnet.TelnetOption): void {
        if (this.options.GetState(option) === _Telnet.TelnetOptionState.DISABLED) {
            this.options.SetState(option, _Telnet.TelnetOptionState.WAITING);
            this.sendTelnet(_Telnet.TelnetNegotiation.DONT, option);
        }
    }
    public goAhead(): void {
        if (!this.options.HasOption(_Telnet.TelnetOption.SUPPRESS_GO_AHEAD))
            this.send(Buffer.from([_Telnet.TelnetNegotiation.IAC, _Telnet.TelnetNegotiation.GA]));
    }
    public prompt(message: string, mask: boolean = false): Promise<string> {
        if (mask) {
            this.dont(_Telnet.TelnetOption.ECHO);
        }
        return new Promise((resolve, reject) => {
            this.responder = (data) => {
                if (mask) {
                    this.do(_Telnet.TelnetOption.ECHO);
                }
                resolve(data);
            };
            this.send(message);
            this.goAhead();
        });
    }
    private HandleData(data: Buffer) {
        const event: Nullable<_Telnet.TelnetEvent> = _Telnet.ParseSequence(data);
        if (event !== null) {
            // Telnet event
            this.emit("telnet", event);
            switch (event.command) {
                case _Telnet.TelnetNegotiation.SB:
                    this.emit("subnegotiation", event.option, event.data || Buffer.alloc(0));
                    if (event.option === _Telnet.TelnetOption.GMCP && event.data !== undefined) {
                        // Process GMCP
                        const d = event.data.toString();
                        let offset = d.indexOf(" ", 0);
                        if (offset === -1) offset = d.length;
                        const namespace = d.substring(0, offset);
                        const objString = offset !== d.length ? d.substring(offset + 1, d.length) : "";
                        if (objString.length > 0) {
                            try {
                                const obj = JSON.parse(objString);
                                this.emit("gmcp", namespace, obj);
                            } catch {
                                this.emit("gmcp", namespace, { data: objString });
                            }
                        }
                    }
                    break;
                case _Telnet.TelnetNegotiation.WILL:
                    if (this.options.GetState(event.option) === _Telnet.TelnetOptionState.WAITING) {
                        this.options.SetState(event.option, _Telnet.TelnetOptionState.ENABLED);
                    }
                    this.emit("will", event.option);
                    break;
                case _Telnet.TelnetNegotiation.WONT:
                    if (this.options.GetState(event.option) === _Telnet.TelnetOptionState.WAITING) {
                        this.options.SetState(event.option, _Telnet.TelnetOptionState.DISABLED);
                    }
                    this.emit("wont", event.option);
                    break;
                case _Telnet.TelnetNegotiation.DO:
                    if (this.options.GetState(event.option) === _Telnet.TelnetOptionState.WAITING) {
                        this.options.SetState(event.option, _Telnet.TelnetOptionState.ENABLED);
                    }
                    this.emit("do", event.option);
                    break;
                case _Telnet.TelnetNegotiation.DONT:
                    if (this.options.GetState(event.option) === _Telnet.TelnetOptionState.WAITING) {
                        this.options.SetState(event.option, _Telnet.TelnetOptionState.DISABLED);
                    }
                    this.emit("dont", event.option);
                    break;
            }
        } else {
            const message: string = data.toString("utf-8");
            if (this.responder !== null) {
                this.responder(message);
                this.responder = null;
            } else {
                this.emit("message", message);
            }
        }
    }

    // Events
    public on(event: "error", listener: (error: Error) => void): this;
    public on(event: "message", listener: (data: string) => void): this;
    public on(event: "close", listener: (code?: number, reason?: string) => void): this;
    public on(event: "ping" | "pong", listener: (data?: Buffer) => void): this;
    public on(event: "will" | "wont" | "do" | "dont", listener: (option: number) => void): this;
    public on(event: "subnegotiation", listener: (option: number, data: Buffer) => void): this;
    public on(event: "telnet", listener: (ev: _Telnet.TelnetEvent) => void): this;
    public on(event: "open", listener: () => void): this;
    public on(event: "gmcp", listener: (namespace: string, data: { [key: string]: any }) => void): this;
    public on(event: string, listener: (...args: any) => void): this {
        return super.on(event, listener);
    }
    public emit(event: "error", error: Error): boolean;
    public emit(event: "message", data: string): boolean;
    public emit(event: "close", code?: number, reason?: string): boolean;
    public emit(event: "ping" | "pong", data?: Buffer): boolean;
    public emit(event: "will" | "wont" | "do" | "dont", option: number): boolean;
    public emit(event: "subnegotiation", option: number, data: Buffer): boolean;
    public emit(event: "telnet", ev: _Telnet.TelnetEvent): boolean;
    public emit(event: "open"): boolean;
    public emit(event: "gmcp", namespace: string, data: { [key: string]: any }): boolean;
    public emit(event: string, ...args: any): boolean {
        return super.emit(event, ...args);
    }
}

namespace WST {
    interface WSSOptions {
        cert: string;
        key: string;
    }
    export class Server extends EventEmitter {
        public readonly clients: Map<string, WST> = new Map();
        private _server: WS.Server;
        constructor(host: string, port: number, secure?: WSSOptions) {
            super();
            let server: https.Server | http.Server;
            if (secure !== undefined) {
                server = https.createServer(secure);
            } else {
                server = http.createServer();
            }
            this._server = new WS.Server({
                server,
            });
            this._server.on("listening", () => this.emit("listening", host, port));
            this._server.on("connection", (socket) => {
                let client: WST | null = new WST(socket);
                const uuid: string = client.UUID;
                this.clients.set(client.UUID, client);
                client.on("close", (code, reason) => {
                    this.clients.delete(uuid);
                    client = null;
                });
                this.emit("connection", client);
            });
            this._server.on("error", (err) => this.emit("error", err));
            server.listen(port, host);
        }

        // Events
        public on(event: "listening", listener: (host: string, port: number) => void): this;
        public on(event: "close", listener: () => void): this;
        public on(event: "error", listener: (error: Error) => void): this;
        public on(event: "connection", listener: (client: WST) => void): this;
        public on(event: string, listener: (...args: any) => void): this {
            return super.on(event, listener);
        }
        public emit(event: "listening", host: string, port: number): boolean;
        public emit(event: "close"): boolean;
        public emit(event: "error", error: Error): boolean;
        public emit(event: "connection", client: WST): boolean;
        public emit(event: string, ...args: any): boolean {
            return super.emit(event, ...args);
        }
    }

    export const Telnet = _Telnet;
}

export = WST;
