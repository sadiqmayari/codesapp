export declare class CreateEndpointDto {
    endpointUrl: string;
    secret: string;
    events: string[];
    status?: 'active' | 'inactive';
}
