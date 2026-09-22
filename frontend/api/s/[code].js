import share from "../share.js";
export default function handler(req,res){req.query={...(req.query||{}),slug:req.query?.code||req.query?.slug||""};return share(req,res);}
