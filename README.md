# AWS Work eventer

## Architectural decision records

| ADR | Date | Status | Summary |
| :-- | :--- | :----- | :------ |
| [iac-foundation](docs/decisions/2026-07-19-1900-iac-foundation/adr-body.md) | 2026-07-19 | Accepted | Terraform for the AWS substrate, native S3 state locking, and a delegated Route53 subdomain. |
| [integration-template-and-dual-path](docs/decisions/2026-07-19-2130-integration-template-and-dual-path/adr-body.md) | 2026-07-19 | Accepted | A config-driven integration template every source plugs into, and dual webhook + poller ingestion for GitHub. |

## Introduction

I have previously scoped a highly complex project to deal with distributed eventing. I set up a complex server infrastructure and clients apps to manage all the "complexity". Recently I had an epiphany that I could accomplish ALL of this with a simple S3 bucket.

## Design

Because the rate of the events for this sytems is never going to exceed a few events per second, and mostly won't exceed more than a couple of events per minute, it can be accomplished very simply by writing a json file into an S3 bucket. 

The most naive client can simply list the contenxt of the s3 bucket, partitioned by day or maybe by hour, and get the most recent events trivially. This can even be accomplished by simply using a CLI command aws s3 sync for the most naive implementation on a cron job and an mtime scan.

For the main project, I think we really just need some IaC to setup the S3 bucket, and perhaps a trigger for the bucket that ends up in a notification flowing to some kind of a queue with a TTL that can have multiple subscribers, as I'm going to want to have one subscriber for each client. One for my phone, one for my desktop, one for my laptop and maybe one for any servers I'm working on. But clients may or may not be active and connected, so whatever event pipe we use should have a TTL that perhaps allows the client to catch up a couple of days worth of events, but probably not ever more than a week, which will never be more than probably a few hundred events.

Then comes the other piece which is the event listener mechanism. I think probably the one actively connected listener I'm going to want is a webhook processor. So I can connect a 3P system like github or stripe to a URL which receives webhook notifications.  Naively, I think this system should have it's own internal event model, probably when it was received, which system it was received for, a priority level from maybe 1 to 8, the event type, wether it's informational or requires attention. Whatever the simplest expression for this is, we should probably use that - my initial guess is an AWS lambda with an API gateway connector. The AWS Lambda, written in Typescript as my preference, will simply receive these webhook requests, classify them based on the payload and headers, wrap them into our event model, and post them into the S3 bucket. Super simple.

One nice advantage of the S3 bucket is that I'll always be able to go back through the event list and see my history.

An alert or even an notification can be actively acknowledged by setting the acknowledged field to true. An event body also has a flag to indicate if it's been handled or not, and a URL to any kind of ticketting system where a ticket can be hosted which will ultimately have it's own workflow and statuses which a more sophisticated client may choose to interact with as part of the payload.

I think as a crude but effective way of indexing the events, we can use a file name that starts with the date in ISO format so it naturally sorts, followed by a priority designation, followed by the event type, currently I have only 'notification', and 'alert', and then the source system identity, and then maybe the event name so something like:

{timestamp}.{type}.{priority}.{source}.{name}.json

for example:

2026-06-28T18:44:30.123Z.alert.p5.github.new-pull-request.json

which internally will have the format:

```typescript
const x = {
  "timestamp": "2026-06-28T18:44:30.123Z",
  "eventType": "alert",
  "priority": 5,
  "source": "github",
  "acknowledged": false,
  "handled": false,
  "workItem": "https://www.jira.com/..."
  "name": "new-pull-request",
  "payload" : { ... the github event webhook payload }
}
```

# Persistent clients

Some of the sources will likely require some kind of persistent-permanently active client system. I'm hoping this might be easy to do as a simple TypeScript server process, maybe running express, maybe that's not even necessary deployed via a docker image to some cheap cloud provider like Railway. Railway is also a nice choice because I can also host a simple Event UI there also.

## Potential Event Sources
- Github webhooks
- LLM Agent CLI events
  - When prompts complete
  - When the LLM has a question
- Email received 
  - VIP Emails receive a higher priority and potentially generate alert vs info types.
- Meeting approaching
  - Especially important for a meeting that requires some pre-prep work.
- Calendar event upcomming
- Daily calendar summary notification
- Package delivery notification
- Slack Message notification
- Pages from Incident systems for IT systems
- Jira
- Airtable
- Confluence

## Initial Sources To Incorporate in a first version
- Github
- LLM Agents
- Slack Messages

