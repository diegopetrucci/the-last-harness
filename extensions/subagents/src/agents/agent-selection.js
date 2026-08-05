export function mergeAgentsForScope(scope, userAgents, projectAgents, builtinAgents = [], packageAgents = []) {
    const agentMap = new Map();
    for (const agent of builtinAgents)
        agentMap.set(agent.name, agent);
    for (const agent of packageAgents)
        agentMap.set(agent.name, agent);
    if (scope === "both") {
        for (const agent of userAgents)
            agentMap.set(agent.name, agent);
        for (const agent of projectAgents)
            agentMap.set(agent.name, agent);
    }
    else if (scope === "user") {
        for (const agent of userAgents)
            agentMap.set(agent.name, agent);
    }
    else {
        for (const agent of projectAgents)
            agentMap.set(agent.name, agent);
    }
    return Array.from(agentMap.values());
}
