import WS from "ws";
import { EventEmitter } from "events";
import WClient from "./client";
import https from "https";
import http from "http";
import telnet from "./telnet";

interface WSSOptions {
    cert: string;
    key: string;
}

class WTServer extends EventEmitter {
    public readonly clients: Map<string, WClient> = new Map();
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
            let client: WClient | null = new WClient(socket);
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
    public on(event: "connection", listener: (client: WClient) => void): this;
    public on(event: string, listener: (...args: any) => void): this {
        return super.on(event, listener);
    }
    public emit(event: "listening", host: string, port: number): boolean;
    public emit(event: "close"): boolean;
    public emit(event: "error", error: Error): boolean;
    public emit(event: "connection", client: WClient): boolean;
    public emit(event: string, ...args: any): boolean {
        return super.emit(event, ...args);
    }
}

namespace WTServer {
    export const WTClient = WClient;
    export const Telnet = telnet;
}

export = WTServer;
