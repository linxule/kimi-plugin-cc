export class ApprovalDispatcher {
    policy;
    constructor(policy) {
        this.policy = policy;
    }
    async handle(request, context) {
        return this.policy(request, context);
    }
}
export function rejectAllApprovals(feedback) {
    return async () => ({
        response: "reject",
        feedback,
    });
}
