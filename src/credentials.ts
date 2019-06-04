import {credentials, Metadata, ChannelCredentials} from "grpc";
import {TokenSignature} from "./signature";
import {AuthClient} from './wrapped/Auth';
import {AuthRequest, AuthResponse} from "./generated/auth_pb";

class CredentialsContext {
    url: string;
    private readonly ca: Buffer;
    private readonly ssl: ChannelCredentials;
    private authentication: EmeraldAuthentication;
    private token: Promise<TokenSignature>;

    constructor(url: string, ca: string | Buffer) {
        this.url = url;
        if (typeof ca == 'string') {
            this.ca = Buffer.from(ca, 'utf8')
        } else {
            this.ca = ca;
        }
        this.ssl = credentials.createSsl(this.ca);
    }

    getSsl(): ChannelCredentials {
        return this.ssl
    }

    getSigner(): Promise<TokenSignature> {
        if (!this.authentication) {
            this.authentication = new BasicUserAuth(this.url, this.getSsl());
        }
        if (!this.token) {
            this.token = this.authentication.authenticate();
        }
        return this.token;
    }
}

class Connected {
    existing: CredentialsContext[];

    constructor() {
        this.existing = []
    }

    getOrCreate(url: string, ca: string | Buffer): CredentialsContext {
        const found = this.existing.find((it) => it.url === url);
        if (found) {
            return found;
        }
        const created = new CredentialsContext(url, ca);
        this.existing.push(created);
        return created;
    }
}

const connected = new Connected();

export function emeraldCredentials(url: string, ca: string | Buffer): ChannelCredentials {
    const ctx = connected.getOrCreate(url, ca);
    const ssl = ctx.getSsl();
    const callCredentials = credentials.createFromMetadataGenerator(
        (params: { service_url: string }, callback: (error: Error | null, metadata?: Metadata) => void) => {
        ctx.getSigner().then((ts) => {
            let signature = ts.next();
            // console.log("auth", params.service_url, signature.msg, signature.signature);
            if (!signature) {
                callback(new Error("No signature"));
                return;
            }
            let meta = new Metadata();
            meta.add("token", signature.token);
            meta.add("nonce", signature.msg);
            meta.add("sign", signature.signature);
            callback(null, meta)
        }).catch((err) => {
            callback(new Error("Unable to get token"))
        })
    });
    return credentials.combineChannelCredentials(ssl, callCredentials)
}

interface EmeraldAuthentication {
    authenticate(): Promise<TokenSignature>
}

class BasicUserAuth implements EmeraldAuthentication {
    client: AuthClient;

    constructor(url: string, cred: ChannelCredentials) {
        this.client = new AuthClient(url, cred);
    }

    authenticate(): Promise<TokenSignature> {
        const authRequest = new AuthRequest();
        authRequest.setSupportedTokensList(["NONCE_HMAC_SHA256"]);
        authRequest.setScopesList(["BASIC_USER"]);
        return this.client.authenticate(authRequest).then((result: AuthResponse) => {
            if (!result.getSucceed()) {
                throw new Error(`Failed to auth ${result.getDenyCode()}: ${result.getDenyMessage()}`);
            }
            return new TokenSignature(result.getToken(), result.getSecret());
        });
    }

}