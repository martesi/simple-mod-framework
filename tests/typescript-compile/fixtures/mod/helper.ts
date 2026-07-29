export enum Greeting {
	Hello = "hello",
	Goodbye = "goodbye"
}

export function shout(message: string): string {
	return message.toUpperCase() + "!"
}
