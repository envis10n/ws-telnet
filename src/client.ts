import WS from "ws";
import { EventEmitter } from "events";
import Telnet from "./telnet";
import { v4 } from "uuid";

class WTClient extends EventEmitter {
    public readonly UUID: string = v4();
    private socket: WS;
    public readonly options: Telnet.TelnetOptionMatrix = new Telnet.TelnetOptionMatrix();
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
    private sendTelnet(command: Telnet.TelnetNegotiation, option: Telnet.TelnetOption, data?: Buffer): void {
        switch (command) {
            case Telnet.TelnetNegotiation.SB:
                if (data !== undefined) {
                    this.send(
                        Buffer.from([
                            Telnet.TelnetNegotiation.IAC,
                            command,
                            option,
                            ...data,
                            Telnet.TelnetNegotiation.IAC,
                            Telnet.TelnetNegotiation.SE,
                        ]),
                    );
                } else {
                    this.send(
                        Buffer.from([
                            Telnet.TelnetNegotiation.IAC,
                            command,
                            option,
                            0,
                            Telnet.TelnetNegotiation.IAC,
                            Telnet.TelnetNegotiation.SE,
                        ]),
                    );
                }
                break;
            default:
                this.send(Buffer.from([Telnet.TelnetNegotiation.IAC, command, option]));
                break;
        }
    }
    public sendSubnegotiation(option: Telnet.TelnetOption, data: Buffer): void;
    public sendSubnegotiation(option: Telnet.TelnetOption, data: string): void;
    public sendSubnegotiation(option: Telnet.TelnetOption, data: Buffer | string): void {
        if (typeof data === "string") {
            data = Buffer.from(data, "utf-8");
        }
        this.sendTelnet(Telnet.TelnetNegotiation.SB, option, data);
    }
    public will(option: Telnet.TelnetOption): void {
        if (this.options.GetState(option) === Telnet.TelnetOptionState.DISABLED) {
            this.options.SetState(option, Telnet.TelnetOptionState.WAITING);
            this.sendTelnet(Telnet.TelnetNegotiation.WILL, option);
        }
    }
    public wont(option: Telnet.TelnetOption): void {
        if (this.options.GetState(option) === Telnet.TelnetOptionState.DISABLED) {
            this.options.SetState(option, Telnet.TelnetOptionState.WAITING);
            this.sendTelnet(Telnet.TelnetNegotiation.WONT, option);
        }
    }
    public do(option: Telnet.TelnetOption): void {
        if (this.options.GetState(option) === Telnet.TelnetOptionState.DISABLED) {
            this.options.SetState(option, Telnet.TelnetOptionState.WAITING);
            this.sendTelnet(Telnet.TelnetNegotiation.DO, option);
        }
    }
    public dont(option: Telnet.TelnetOption): void {
        if (this.options.GetState(option) === Telnet.TelnetOptionState.DISABLED) {
            this.options.SetState(option, Telnet.TelnetOptionState.WAITING);
            this.sendTelnet(Telnet.TelnetNegotiation.DONT, option);
        }
    }
    public prompt(message: string, mask: boolean = false): Promise<string> {
        if (mask) {
            this.dont(Telnet.TelnetOption.ECHO);
        }
        return new Promise((resolve, reject) => {
            this.responder = (data) => {
                if (mask) {
                    this.do(Telnet.TelnetOption.ECHO);
                }
                resolve(data);
            };
            this.send(message);
        });
    }
    private HandleData(data: Buffer) {
        const event: Nullable<Telnet.TelnetEvent> = Telnet.ParseSequence(data);
        if (event !== null) {
            // Telnet event
            this.emit("telnet", event);
            switch (event.command) {
                case Telnet.TelnetNegotiation.SB:
                    this.emit("subnegotiation", event.option, event.data || Buffer.alloc(0));
                    break;
                case Telnet.TelnetNegotiation.WILL:
                    if (this.options.GetState(event.option) === Telnet.TelnetOptionState.WAITING) {
                        this.options.SetState(event.option, Telnet.TelnetOptionState.ENABLED);
                    }
                    this.emit("will", event.option);
                    break;
                case Telnet.TelnetNegotiation.WONT:
                    if (this.options.GetState(event.option) === Telnet.TelnetOptionState.WAITING) {
                        this.options.SetState(event.option, Telnet.TelnetOptionState.DISABLED);
                    }
                    this.emit("wont", event.option);
                    break;
                case Telnet.TelnetNegotiation.DO:
                    if (this.options.GetState(event.option) === Telnet.TelnetOptionState.WAITING) {
                        this.options.SetState(event.option, Telnet.TelnetOptionState.ENABLED);
                    }
                    this.emit("do", event.option);
                    break;
                case Telnet.TelnetNegotiation.DONT:
                    if (this.options.GetState(event.option) === Telnet.TelnetOptionState.WAITING) {
                        this.options.SetState(event.option, Telnet.TelnetOptionState.DISABLED);
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
    public on(event: "telnet", listener: (ev: Telnet.TelnetEvent) => void): this;
    public on(event: "open", listener: () => void): this;
    public on(event: string, listener: (...args: any) => void): this {
        return super.on(event, listener);
    }
    public emit(event: "error", error: Error): boolean;
    public emit(event: "message", data: string): boolean;
    public emit(event: "close", code?: number, reason?: string): boolean;
    public emit(event: "ping" | "pong", data?: Buffer): boolean;
    public emit(event: "will" | "wont" | "do" | "dont", option: number): boolean;
    public emit(event: "subnegotiation", option: number, data: Buffer): boolean;
    public emit(event: "telnet", ev: Telnet.TelnetEvent): boolean;
    public emit(event: "open"): boolean;
    public emit(event: string, ...args: any): boolean {
        return super.emit(event, ...args);
    }
}

export = WTClient;
