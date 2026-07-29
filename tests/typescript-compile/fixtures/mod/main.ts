import { Greeting, shout } from "./helper"

interface Payload {
	name: string
	count: number
}

export async function analysis(payload: Payload): Promise<string> {
	const base: string = `${Greeting.Hello}, ${payload.name} (x${payload.count})`
	return shout(base)
}
