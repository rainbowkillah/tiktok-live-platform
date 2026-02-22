import React, { useState, useEffect } from 'react';

const EventFeed = () => {
  const [events, setEvents] = useState([]);
  const streamId = 'hardcoded-stream-id'; // Replace with dynamic streamId

  useEffect(() => {
    const eventSource = new EventSource(`/streams/${streamId}/events`);

    eventSource.onmessage = (event) => {
      try {
        const newEvent = JSON.parse(event.data);
        setEvents((prevEvents) => [newEvent, ...prevEvents]);
      } catch (error) {
        console.error('Failed to parse event:', error);
      }
    };

    eventSource.onerror = (error) => {
      console.error('EventSource failed:', error);
      eventSource.close();
    };

    return () => {
      eventSource.close();
    };
  }, [streamId]);

  return (
    <div>
      <h2>Event Feed</h2>
      <ul>
        {events.map((event, index) => (
          <li key={index}>{JSON.stringify(event)}</li>
        ))}
      </ul>
    </div>
  );
};

export default EventFeed;
