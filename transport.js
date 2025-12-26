import { config } from "./config.js";

export const createNewTransport=async(mediasoupRouter,webRtcServer)=>{
   const {initialAvailableOutgoingBitrate,maxIncomeBitrate} = config.mediasoup.webRtcTransport

   const transport = await mediasoupRouter.createWebRtcTransport({
    webRtcServer,
    enableUdp:true,
    enableTcp:true,
    preferUdp:true,
    enableSctp: true,
    initialAvailableOutgoingBitrate,
    iceConsentTimeout: 0
   })

   if(maxIncomeBitrate){
    try{
    transport.setMaxIncomingBitrate(maxIncomeBitrate)
    }
    catch(err){
        console.error(err)
    }
   }

   return {
    transport,
    params:{
        id:transport.id,
        iceParameters:transport.iceParameters,
        iceCandidates:transport.iceCandidates,
        dtlsParameters:transport.dtlsParameters,
        sctpParameters:transport.sctpParameters
    }
   }

}
