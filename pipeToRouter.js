import { config } from "./config.js";

export async function pipeToRouter(
    producerId,
    originalRouter,
    destinationRouter
) {

    if (!producerId) {
        throw new TypeError('missing producer Id');
    }
    else if (!originalRouter) {
        throw new TypeError('Original Router not given');
    }
    else if (!destinationRouter) {
        throw new TypeError('Destination Router not given');
    }

        const localPipeTransport = await originalRouter?.createPipeTransport(
            { listenInfo: config.mediasoup.pipeTransport.listenInfo})
        const remotePipeTransport = await destinationRouter?.createPipeTransport(
            { listenInfo: config.mediasoup.pipeTransport.listenInfo})

        await localPipeTransport.connect(
            {
                ip: remotePipeTransport.tuple.localIp,
                port: remotePipeTransport.tuple.localPort,
                srtpParameters: remotePipeTransport.srtpParameters
            });

        await remotePipeTransport.connect(
            {
                ip: localPipeTransport.tuple.localIp,
                port: localPipeTransport.tuple.localPort,
                srtpParameters: localPipeTransport.srtpParameters
            })

        localPipeTransport.observer.on('close', () => {
            remotePipeTransport.close();

        });

        remotePipeTransport.observer.on('close', () => {
           localPipeTransport.close();
        })


        const pipeConsumer = await localPipeTransport?.consume(
            {
                producerId: producerId
            });

        const pipeProducer = await remotePipeTransport?.produce(
            {
                id: producerId,
                kind: pipeConsumer?.kind,
                rtpParameters: pipeConsumer?.rtpParameters,
                paused: pipeConsumer?.producerPaused,
            });

        pipeConsumer.observer.on('close', () => {
            localPipeTransport.close()
        });
        pipeConsumer.observer.on('pause', () => {
             pipeProducer?.pause()

        });
        pipeConsumer.observer.on('resume', () => {
             pipeProducer?.resume();

        });

        pipeProducer.observer.on('close', () => {
           remotePipeTransport?.close()
        });

        return {pipeConsumer,pipeProducer}

}
