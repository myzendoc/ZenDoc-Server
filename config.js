

export const config ={
    mediasoup:{
        worker:{
            logLevel:'debug',
            logTags:[
                'info',
                'ice',
                'dtls',
                'srtp',
            ] 
        },
        router:{
            mediaCodecs:[
                {
                    kind:'audio',
                    mimeType:'audio/opus',
                    clockRate: 48000,
                    channels: 2
                },
                {
                    kind:'video',
                    mimeType:'video/VP9',
                    clockRate: 90000,
                },
                {
                    kind: "video",
                    mimeType: "video/H264",
                    clockRate: 90000,
                    parameters: {
                      "packetization-mode": 1,
                      "profile-level-id": "42e01f",
                      "level-asymmetry-allowed": 1
                    }
                }
            ]
        },
        webRtcServer:{
            listenInfos:[
                {
                    protocol:"udp",
                    ip:'0.0.0.0',
                    announcedAddress:'192.168.1.41',
                    portRange:
					{
						min : 40000,
						max : 59999,
					}
                },
                {
                    protocol:"tcp",
                    ip:'0.0.0.0',
                    announcedAddress:'192.168.1.41',
                    portRange:
					{
						min : 40000,
						max : 59999,
					}
                }
            ]
        },
        webRtcTransport:{
            maxIncomeBitrate: 2000000,
            initialAvailableOutgoingBitrate: 1000000,
        },
        pipeTransport:{
            listenInfo:
                {
                    protocol:"udp",
                    ip:'0.0.0.0',
                    announcedAddress:'192.168.1.41',
                    portRange:
					{
						min : 40000,
						max : 59999,
					}
                }
        },
          plainTransport: {
      listenInfo: {
        protocol: "udp",
        ip: "0.0.0.0",
        announcedAddress: '192.168.1.41',
        portRange: {
          min: 30000,
          max: 39999,
        },
      },
      rtcpMux: false,
      comedia: false,
    },
    }
}