import { PublicService } from './public.service';
export declare class PublicController {
    private readonly publicService;
    constructor(publicService: PublicService);
    pricing(): Promise<import("./public.service").PublicPlan[]>;
}
