export class IPData {
    tempMuteExpireTimeout;
    muted;
    vote;
    address;
    constructor(address) {
        this.address = address;
        this.muted = false;
        this.vote = null;
    }
}
